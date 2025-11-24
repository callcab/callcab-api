// src/handlers/memory-store.js
// FINAL PRODUCTION VERSION - Claire v4.1 Memory Storage System
// Handles: VAPI webhooks + direct storage + comprehensive conversation memory

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Rate limiting configuration
const MEMORY_RATE_LIMITS = {
  PER_PHONE_PER_MINUTE: 5,     // Max 5 stores per phone per minute
  PER_IP_PER_MINUTE: 20,       // Max 20 stores per IP per minute
  PER_PHONE_PER_HOUR: 30,      // Max 30 stores per phone per hour
  GLOBAL_PER_MINUTE: 100       // Max 100 total stores per minute
};

// Data size limits
const DATA_LIMITS = {
  MAX_STRUCTURED_DATA_SIZE: 5000,    // 5KB limit for structured data
  MAX_FIELD_LENGTH: 500,             // 500 chars per field
  MAX_SUMMARY_LENGTH: 300,           // 300 chars for summaries
  MAX_TOPICS_COUNT: 10,              // Max 10 conversation topics
  MAX_PERSONAL_DETAILS_LENGTH: 1000, // 1KB for personal details
  EXPIRATION_TTL: 60 * 60 * 24 * 90  // 90 days expiration
};

/**
 * Store call memory from VAPI webhooks or direct structured data
 * Handles comprehensive conversation context with proper prioritization
 */
export async function handleMemoryStore(request, env) {
  const startTime = Date.now();

  try {
    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ 
        ok: false, 
        error: 'METHOD_NOT_ALLOWED',
        message: 'Only POST requests allowed'
      }, 405);
    }

    const body = await request.json();
    
    // Determine data source and validate
    const { dataSource, structuredData, phone } = processIncomingData(body);
    
    if (!phone) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_PHONE',
        message: 'Phone number is required',
        hint: 'Include phone field in request body or VAPI webhook structure',
        data_source: dataSource,
        available_keys: Object.keys(structuredData || {})
      }, 400);
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return jsonResponse({
        ok: false,
        error: 'INVALID_PHONE',
        message: 'Invalid phone number format',
        provided: phone
      }, 400);
    }

    // Rate limiting check
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const rateLimitResult = await checkMemoryRateLimit(normalizedPhone, clientIP, env);
    
    if (!rateLimitResult.allowed) {
      console.warn('[MemoryStore] Rate limit exceeded:', rateLimitResult.reason);
      return jsonResponse({
        ok: false,
        error: 'RATE_LIMITED',
        message: 'Too many memory storage requests. Please wait.',
        retry_after: rateLimitResult.retry_after || 60
      }, 429);
    }

    // Check KV availability
    if (!env.CALL_MEMORIES) {
      return jsonResponse({
        ok: false,
        error: 'KV_NOT_CONFIGURED',
        message: 'Memory storage is not configured'
      }, 500);
    }

    // Validate and sanitize data
    const validatedData = validateAndSanitizeData(structuredData);
    if (!validatedData.valid) {
      return jsonResponse({
        ok: false,
        error: 'INVALID_DATA',
        message: 'Data validation failed',
        issues: validatedData.issues
      }, 400);
    }

    // Process and store memory
    const memoryRecord = await buildMemoryRecord(normalizedPhone, validatedData.data, env);
    const storageResult = await storeMemoryRecord(normalizedPhone, memoryRecord, env);

    // Update rate limits
    await updateMemoryRateLimit(normalizedPhone, clientIP, env);

    console.log('[MemoryStore] ✅ Memory stored successfully:', {
      phone: normalizedPhone,
      data_source: dataSource,
      outcome: memoryRecord.outcome,
      aggregated_fields: memoryRecord.aggregated_context ? Object.keys(memoryRecord.aggregated_context) : [],
      size_bytes: JSON.stringify(memoryRecord).length
    });

    return jsonResponse({
      ok: true,
      phone: normalizedPhone,
      stored_at: memoryRecord.timestamp,
      data_source: dataSource,
      fields_stored: Object.keys(memoryRecord).length,
      data_size_bytes: JSON.stringify(memoryRecord).length,
      aggregated_context_stored: !!memoryRecord.aggregated_context,
      aggregated_fields: memoryRecord.aggregated_context ? Object.keys(memoryRecord.aggregated_context) : [],
      expires_in_days: 90,
      storage_keys: storageResult.keys_created,
      processing_time_ms: Date.now() - startTime
    });

  } catch (error) {
    console.error('[MemoryStore] Fatal error:', error);
    console.error('[MemoryStore] Stack:', error.stack);
    
    return jsonResponse({
      ok: false,
      error: 'STORAGE_FAILED',
      message: 'Memory storage failed',
      details: error.message,
      processing_time_ms: Date.now() - startTime
    }, 500);
  }
}

/**
 * Process incoming data to determine source and extract structured data
 */
function processIncomingData(body) {
  let dataSource = 'unknown';
  let structuredData = {};
  let phone = null;

  console.log('[MemoryStore] Processing incoming data:', {
    hasMessage: !!body.message,
    hasArtifact: !!body.artifact,
    messageType: body.message?.type,
    topLevelKeys: Object.keys(body)
  });

  // VAPI Webhook Detection
  if (body.message || body.artifact || body.type) {
    dataSource = 'vapi_webhook';
    
    // Extract structured data from VAPI webhook
    structuredData = body.message?.artifact || body.artifact || {};
    
    // Extract phone from multiple VAPI locations (comprehensive search)
    phone = structuredData.phone || 
            body.message?.call?.customer?.number ||
            body.call?.customer?.number ||
            body.customer?.number ||
            body.message?.phoneNumber ||
            body.phoneNumber ||
            body.message?.customerNumber ||
            body.customerNumber;

    console.log('[MemoryStore] VAPI phone extraction attempts:', {
      structured_phone: structuredData.phone,
      message_call_customer: body.message?.call?.customer?.number,
      call_customer: body.call?.customer?.number,
      customer_number: body.customer?.number,
      message_phoneNumber: body.message?.phoneNumber,
      phoneNumber: body.phoneNumber,
      found_phone: phone
    });

    // Validate webhook type
    const messageType = body.message?.type || body.type;
    if (messageType && messageType !== 'end-of-call-report') {
      console.log('[MemoryStore] Ignoring webhook type:', messageType);
      return { dataSource, structuredData: {}, phone: null }; // Ignore non-end-of-call
    }

    // Must have structured data for storage
    if (!structuredData || Object.keys(structuredData).length < 2) {
      console.log('[MemoryStore] No structured data in VAPI webhook');
      return { dataSource, structuredData: {}, phone: null };
    }

  } else if (body.phone && (body.outcome || body.preferred_name || body.language_used)) {
    // Direct structured data (testing/manual)
    dataSource = 'direct_storage';
    structuredData = body;
    phone = body.phone;

  } else {
    // Invalid format
    console.error('[MemoryStore] Invalid request format');
    return { dataSource: 'invalid', structuredData: {}, phone: null };
  }

  // Fallback: Deep search for phone number if not found in standard locations
  if (!phone) {
    console.warn('[MemoryStore] No phone in standard locations, performing deep search...');
    phone = extractPhoneFromBody(body);
    if (phone) {
      console.log('[MemoryStore] Found phone via deep search:', phone);
      dataSource += '_deep_search';
    }
  }

  // Final phone validation and normalization
  if (phone) {
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone) {
      phone = normalizedPhone;
      console.log('[MemoryStore] Phone normalized to:', phone);
    } else {
      console.error('[MemoryStore] Phone normalization failed for:', phone);
      phone = null;
    }
  } else {
    console.error('[MemoryStore] No phone number found anywhere in request');
  }

  return { dataSource, structuredData, phone };
}

/**
 * Deep search for phone number patterns in request body
 */
function extractPhoneFromBody(obj, path = '', visited = new WeakSet()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
  visited.add(obj);
  
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    
    // Check if this key looks like it contains a phone number
    if (typeof value === 'string' && value.length >= 7) {
      // Look for phone-like keys
      if (/phone|number|caller|customer/i.test(key)) {
        const digits = value.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 15) {
          console.log('[MemoryStore] Found phone at key path:', currentPath, value);
          return value;
        }
      }
      
      // Look for phone-like values (E164, 001, +1, etc.)
      if (/^(\+?1?|001)?\d{10,15}$/.test(value.replace(/\D/g, ''))) {
        const digits = value.replace(/\D/g, '');
        if (digits.length >= 10 && digits.length <= 15) {
          console.log('[MemoryStore] Found phone-like value at path:', currentPath, value);
          return value;
        }
      }
    }
    
    // Recursively search nested objects/arrays
    if (typeof value === 'object' && value !== null && !visited.has(value)) {
      const found = extractPhoneFromBody(value, currentPath, visited);
      if (found) return found;
    }
  }
  
  return null;
}

/**
 * Validate and sanitize incoming data
 */
function validateAndSanitizeData(data) {
  const issues = [];
  const sanitized = {};

  // Check data size
  const dataString = JSON.stringify(data);
  if (dataString.length > DATA_LIMITS.MAX_STRUCTURED_DATA_SIZE) {
    issues.push(`Data too large: ${dataString.length} > ${DATA_LIMITS.MAX_STRUCTURED_DATA_SIZE} bytes`);
    return { valid: false, issues };
  }

  // Required fields
  sanitized.phone = data.phone;
  const outcomeResult = sanitizeString(data.outcome);
  sanitized.outcome = (outcomeResult && outcomeResult.value) ? outcomeResult.value : (data.outcome || 'call_completed');
  sanitized.timestamp = new Date().toISOString();

  // Optional fields with validation and sanitization
  const fieldMappings = {
    // Call context
    language_used: { sanitizer: sanitizeLanguage, default: 'english' },
    preferred_language: { sanitizer: sanitizeLanguage, default: '' },
    behavior: { sanitizer: sanitizeEnum, options: ['polite', 'friendly', 'grateful', 'neutral', 'impatient', 'rude', 'confused', 'intoxicated'], default: 'neutral' },
    conversation_state: { sanitizer: sanitizeString, maxLength: 50 },
    
    // Location data
    last_pickup: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    last_dropoff: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    last_dropoff_lat: { sanitizer: sanitizeCoordinate, type: 'latitude' },
    last_dropoff_lng: { sanitizer: sanitizeCoordinate, type: 'longitude' },
    last_trip_id: { sanitizer: sanitizeString, maxLength: 50 },
    
    // Personal context
    preferred_name: { sanitizer: sanitizeName, maxLength: 100 },
    preferred_pickup_address: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    
    // Conversation context
    behavior_notes: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    trip_discussion: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    greeting_response: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    relationship_context: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    jokes_shared: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    personal_details: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_PERSONAL_DETAILS_LENGTH },
    
    // Operational notes
    special_instructions: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    operational_notes: { sanitizer: sanitizeString, maxLength: DATA_LIMITS.MAX_FIELD_LENGTH },
    
    // Boolean flags
    was_dropped: { sanitizer: sanitizeBoolean },
    callback_confirmed: { sanitizer: sanitizeBoolean }
  };

  // Process each field
  for (const [field, config] of Object.entries(fieldMappings)) {
    if (data[field] !== undefined && data[field] !== null && data[field] !== '') {
      const result = config.sanitizer(data[field], config);
      if (result.valid) {
        sanitized[field] = result.value;
      } else {
        issues.push(`${field}: ${result.error}`);
      }
    }
  }

  // Special handling for arrays and objects
  if (data.conversation_topics && Array.isArray(data.conversation_topics)) {
    sanitized.conversation_topics = data.conversation_topics
      .slice(0, DATA_LIMITS.MAX_TOPICS_COUNT)
      .map(topic => {
        const result = sanitizeString(topic, { maxLength: 100 });
        return result.valid ? result.value : '';
      })
      .filter(Boolean);
  }

  if (data.collected_info && typeof data.collected_info === 'object') {
    sanitized.collected_info = sanitizeCollectedInfo(data.collected_info);
  }

  // Set outcome flags
  sanitized.was_dropped = sanitized.was_dropped || sanitized.outcome === 'dropped_call';

  return {
    valid: issues.length === 0,
    data: sanitized,
    issues
  };
}

/**
 * Build comprehensive memory record with aggregated context
 */
async function buildMemoryRecord(phone, data, env) {
  const timestamp = new Date().toISOString();
  
  // Get existing memory for aggregated context merging
  const existingMemory = await getExistingMemory(phone, env);
  
  // Build base memory record
  const memoryRecord = {
    phone,
    timestamp,
    outcome: data.outcome,
    language_used: data.language_used || 'english',
    behavior: data.behavior || 'neutral',
    conversation_state: data.conversation_state || 'completed',
    was_dropped: data.was_dropped || false,
    
    // Call details (only if applicable)
    ...(data.last_pickup && { last_pickup: data.last_pickup }),
    ...(data.last_dropoff && { last_dropoff: data.last_dropoff }),
    ...(data.last_dropoff_lat && { last_dropoff_lat: data.last_dropoff_lat }),
    ...(data.last_dropoff_lng && { last_dropoff_lng: data.last_dropoff_lng }),
    ...(data.last_trip_id && { last_trip_id: data.last_trip_id }),
    
    // Conversation context
    ...(data.behavior_notes && { behavior_notes: data.behavior_notes }),
    ...(data.trip_discussion && { trip_discussion: data.trip_discussion }),
    ...(data.greeting_response && { greeting_response: data.greeting_response }),
    ...(data.relationship_context && { relationship_context: data.relationship_context }),
    ...(data.conversation_topics && { conversation_topics: data.conversation_topics }),
    ...(data.jokes_shared && { jokes_shared: data.jokes_shared }),
    ...(data.personal_details && { personal_details: data.personal_details }),
    
    // Operational
    ...(data.special_instructions && { special_instructions: data.special_instructions }),
    ...(data.operational_notes && { operational_notes: data.operational_notes }),
    ...(data.callback_confirmed && { callback_confirmed: data.callback_confirmed }),
    ...(data.collected_info && { collected_info: data.collected_info })
  };

  // Build aggregated context (CRITICAL FOR PREFERENCES)
  const aggregatedContext = buildAggregatedContext(data, existingMemory?.aggregated_context || {});
  if (Object.keys(aggregatedContext).length > 0) {
    memoryRecord.aggregated_context = aggregatedContext;
  }

  // Generate call summary for history
  memoryRecord.call_summary = generateCallSummary(memoryRecord);

  return memoryRecord;
}

/**
 * Build aggregated context with proper preference handling
 */
function buildAggregatedContext(newData, existingContext) {
  const aggregated = { ...existingContext }; // Start with existing preferences

  // Language preference (only store non-English)
  if (newData.preferred_language) {
    if (newData.preferred_language !== 'english' && newData.preferred_language !== '') {
      aggregated.preferred_language = newData.preferred_language;
      console.log('[Memory] Storing language preference:', newData.preferred_language);
    } else {
      // Customer switched to English - clear preference
      delete aggregated.preferred_language;
      console.log('[Memory] Clearing language preference (switched to English)');
    }
  }

  // Name preference (overrides iCabbi forever)
  if (newData.preferred_name && newData.preferred_name.trim()) {
    aggregated.preferred_name = newData.preferred_name.trim();
    console.log('[Memory] Storing name preference:', aggregated.preferred_name);
  }

  // Pickup address preference (for frequent locations)
  if (newData.preferred_pickup_address && newData.preferred_pickup_address.trim()) {
    aggregated.preferred_pickup_address = newData.preferred_pickup_address.trim();
    console.log('[Memory] Storing pickup preference:', aggregated.preferred_pickup_address);
  }

  // Clean empty values
  Object.keys(aggregated).forEach(key => {
    if (aggregated[key] === null || aggregated[key] === undefined || aggregated[key] === '') {
      delete aggregated[key];
    }
  });

  return aggregated;
}

/**
 * Generate call summary for history tracking
 */
function generateCallSummary(memoryRecord) {
  let summary = `${memoryRecord.outcome}`;
  
  if (memoryRecord.last_pickup && memoryRecord.last_dropoff) {
    summary += ` - ${memoryRecord.last_pickup} to ${memoryRecord.last_dropoff}`;
  } else if (memoryRecord.last_pickup) {
    summary += ` - from ${memoryRecord.last_pickup}`;
  }
  
  if (memoryRecord.behavior && memoryRecord.behavior !== 'neutral') {
    summary += ` (${memoryRecord.behavior})`;
  }
  
  if (memoryRecord.personal_details) {
    const details = memoryRecord.personal_details.substring(0, 50);
    summary += ` - ${details}${memoryRecord.personal_details.length > 50 ? '...' : ''}`;
  }

  // Truncate to max length
  return summary.length > DATA_LIMITS.MAX_SUMMARY_LENGTH ? 
    summary.substring(0, DATA_LIMITS.MAX_SUMMARY_LENGTH - 3) + '...' : 
    summary;
}

/**
 * Store memory record in KV with dual keys for access patterns
 */
async function storeMemoryRecord(phone, memoryRecord, env) {
  const timestamp = memoryRecord.timestamp;
  const keysCreated = [];

  try {
    // Key 1: Latest call (overwritten each time)
    const latestKey = `latest:${phone}`;
    await env.CALL_MEMORIES.put(
      latestKey,
      JSON.stringify(memoryRecord),
      { expirationTtl: DATA_LIMITS.EXPIRATION_TTL }
    );
    keysCreated.push(latestKey);

    // Key 2: Historical record (preserved)
    const historyKey = `history:${phone}:${timestamp}`;
    await env.CALL_MEMORIES.put(
      historyKey,
      JSON.stringify(memoryRecord),
      { expirationTtl: DATA_LIMITS.EXPIRATION_TTL }
    );
    keysCreated.push(historyKey);

    // Key 3: Index for cleanup (optional, for future bulk operations)
    const indexKey = `index:${phone}`;
    const existingIndex = await env.CALL_MEMORIES.get(indexKey);
    const indexData = existingIndex ? JSON.parse(existingIndex) : { timestamps: [] };
    
    indexData.timestamps = indexData.timestamps || [];
    indexData.timestamps.push(timestamp);
    indexData.timestamps = indexData.timestamps.slice(-10); // Keep last 10 timestamps
    indexData.last_updated = timestamp;

    await env.CALL_MEMORIES.put(
      indexKey,
      JSON.stringify(indexData),
      { expirationTtl: DATA_LIMITS.EXPIRATION_TTL }
    );
    keysCreated.push(indexKey);

    console.log('[MemoryStore] Stored memory with keys:', keysCreated);
    return { success: true, keys_created: keysCreated };

  } catch (error) {
    console.error('[MemoryStore] Storage error:', error);
    throw new Error(`Failed to store memory: ${error.message}`);
  }
}

/**
 * Get existing memory for context merging
 */
async function getExistingMemory(phone, env) {
  try {
    const latestKey = `latest:${phone}`;
    const existingData = await env.CALL_MEMORIES.get(latestKey);
    return existingData ? JSON.parse(existingData) : null;
  } catch (error) {
    console.warn('[MemoryStore] Could not retrieve existing memory:', error);
    return null;
  }
}

/**
 * Rate limiting for memory storage
 */
async function checkMemoryRateLimit(phone, clientIP, env) {
  try {
    if (!env.CALL_MEMORIES) {
      return { allowed: true };
    }

    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);

    const checks = [
      { key: `memrate:phone:${phone}:${minute}`, limit: MEMORY_RATE_LIMITS.PER_PHONE_PER_MINUTE, window: 'minute' },
      { key: `memrate:phone:${phone}:${hour}`, limit: MEMORY_RATE_LIMITS.PER_PHONE_PER_HOUR, window: 'hour' },
      { key: `memrate:ip:${clientIP}:${minute}`, limit: MEMORY_RATE_LIMITS.PER_IP_PER_MINUTE, window: 'minute' },
      { key: `memrate:global:${minute}`, limit: MEMORY_RATE_LIMITS.GLOBAL_PER_MINUTE, window: 'global' }
    ];

    for (const check of checks) {
      const current = await env.CALL_MEMORIES.get(check.key);
      const count = current ? parseInt(current) : 0;
      
      if (count >= check.limit) {
        return {
          allowed: false,
          reason: `Memory storage ${check.window} limit exceeded`,
          retry_after: check.window === 'hour' ? 3600 : 60
        };
      }
    }

    return { allowed: true };
  } catch (error) {
    console.warn('[MemoryRateLimit] Check failed:', error);
    return { allowed: true };
  }
}

/**
 * Update memory rate limit counters
 */
async function updateMemoryRateLimit(phone, clientIP, env) {
  try {
    if (!env.CALL_MEMORIES) return;

    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);

    const updates = [
      { key: `memrate:phone:${phone}:${minute}`, ttl: 60 },
      { key: `memrate:phone:${phone}:${hour}`, ttl: 3600 },
      { key: `memrate:ip:${clientIP}:${minute}`, ttl: 60 },
      { key: `memrate:global:${minute}`, ttl: 60 }
    ];

    for (const update of updates) {
      const current = await env.CALL_MEMORIES.get(update.key);
      const count = current ? parseInt(current) + 1 : 1;
      await env.CALL_MEMORIES.put(update.key, count.toString(), { expirationTtl: update.ttl });
    }
  } catch (error) {
    console.warn('[MemoryRateLimit] Update failed:', error);
  }
}

// Data sanitization functions

function sanitizeString(value, config = {}) {
  if (typeof value !== 'string') {
    value = String(value);
  }
  
  // Remove potentially harmful characters
  value = value.replace(/[<>\"'&]/g, '');
  value = value.trim();
  
  if (config.maxLength && value.length > config.maxLength) {
    value = value.substring(0, config.maxLength);
  }
  
  return { valid: true, value };
}

function sanitizeName(value, config = {}) {
  const result = sanitizeString(value, config);
  if (!result.valid) return result;
  
  // Name-specific validation
  if (!/^[a-zA-Z\s\-\.\']+$/.test(result.value)) {
    return { valid: false, error: 'Invalid name format' };
  }
  
  return result;
}

function sanitizeLanguage(value) {
  const validLanguages = ['english', 'spanish', 'portuguese', 'german', 'french', ''];
  const cleaned = String(value).toLowerCase().trim();
  
  if (!validLanguages.includes(cleaned)) {
    return { valid: false, error: 'Invalid language code' };
  }
  
  return { valid: true, value: cleaned };
}

function sanitizeEnum(value, config) {
  const cleaned = String(value).toLowerCase().trim();
  
  if (!config.options.includes(cleaned)) {
    return { valid: true, value: config.default };
  }
  
  return { valid: true, value: cleaned };
}

function sanitizeCoordinate(value, config) {
  const num = parseFloat(value);
  
  if (isNaN(num)) {
    return { valid: false, error: 'Invalid coordinate format' };
  }
  
  if (config.type === 'latitude' && (num < -90 || num > 90)) {
    return { valid: false, error: 'Latitude out of range' };
  }
  
  if (config.type === 'longitude' && (num < -180 || num > 180)) {
    return { valid: false, error: 'Longitude out of range' };
  }
  
  return { valid: true, value: num };
}

function sanitizeBoolean(value) {
  if (typeof value === 'boolean') {
    return { valid: true, value };
  }
  
  const cleaned = String(value).toLowerCase().trim();
  return { valid: true, value: cleaned === 'true' || cleaned === '1' };
}

function sanitizeCollectedInfo(info) {
  const sanitized = {};
  
  if (typeof info.has_pickup === 'boolean') sanitized.has_pickup = info.has_pickup;
  if (typeof info.has_destination === 'boolean') sanitized.has_destination = info.has_destination;
  if (typeof info.has_time === 'boolean') sanitized.has_time = info.has_time;
  if (typeof info.passenger_count === 'number') sanitized.passenger_count = Math.max(1, Math.min(20, info.passenger_count));
  
  if (info.pickup_address) {
    const result = sanitizeString(info.pickup_address, { maxLength: 200 });
    if (result.valid) sanitized.pickup_address = result.value;
  }
  
  if (info.destination_address) {
    const result = sanitizeString(info.destination_address, { maxLength: 200 });
    if (result.valid) sanitized.destination_address = result.value;
  }
  
  if (info.items_mentioned) {
    const result = sanitizeString(info.items_mentioned, { maxLength: 200 });
    if (result.valid) sanitized.items_mentioned = result.value;
  }
  
  return sanitized;
}

/**
 * Normalize phone number to E.164 format
 */
function normalizePhone(input) {
  if (!input) return null;
  
  let digits = String(input).replace(/\D/g, '');
  
  // 10 digits: assume US/Canada
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // 11 digits starting with 1: US/Canada with country code
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  // Already has + prefix
  if (String(input).startsWith('+')) {
    return input;
  }
  
  // Other international numbers
  return digits.length >= 10 ? `+${digits}` : null;
}

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}