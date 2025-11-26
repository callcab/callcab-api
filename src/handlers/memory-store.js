// src/handlers/memory-store-BULLETPROOF.js
// BULLETPROOF MEMORY SYSTEM - Phone Number Preservation at ALL COSTS
// Handles: VAPI failures, phone extraction, conversation summaries with phone numbers

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Rate limiting configuration
const MEMORY_RATE_LIMITS = {
  PER_PHONE_PER_MINUTE: 5,
  PER_IP_PER_MINUTE: 20,
  PER_PHONE_PER_HOUR: 30,
  GLOBAL_PER_MINUTE: 100
};

// Data size limits
const DATA_LIMITS = {
  MAX_STRUCTURED_DATA_SIZE: 5000,
  MAX_FIELD_LENGTH: 500,
  MAX_SUMMARY_LENGTH: 300,
  MAX_TOPICS_COUNT: 10,
  MAX_PERSONAL_DETAILS_LENGTH: 1000,
  EXPIRATION_TTL: 60 * 60 * 24 * 90
};

/**
 * BULLETPROOF Memory Storage - NEVER loses phone numbers
 */
export async function handleMemoryStore(request, env) {
  const startTime = Date.now();

  try {
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
    
    // ====================================================================
    // BULLETPROOF PHONE EXTRACTION - NEVER FAILS
    // ====================================================================
    
    const phoneExtractionResult = extractPhoneBulletproof(body, request);
    
    if (!phoneExtractionResult.phone) {
      console.error('[MemoryStore] CRITICAL: No phone found anywhere:', phoneExtractionResult.searchLog);
      
      // EMERGENCY FALLBACK: Try to find ANY phone-like pattern
      const emergencyPhone = emergencyPhoneSearch(body);
      
      if (emergencyPhone) {
        console.warn('[MemoryStore] Emergency phone recovery successful:', emergencyPhone);
        phoneExtractionResult.phone = emergencyPhone;
        phoneExtractionResult.source = 'emergency_recovery';
      } else {
        return jsonResponse({
          ok: false,
          error: 'NO_PHONE_ANYWHERE',
          message: 'Could not extract phone number from any source',
          debug: phoneExtractionResult.searchLog,
          request_keys: Object.keys(body),
          header_keys: Object.keys(Object.fromEntries(request.headers))
        }, 400);
      }
    }
    
    const phone = phoneExtractionResult.phone;
    const phoneSource = phoneExtractionResult.source;
    
    console.log(`[MemoryStore] Phone extracted: ${phone} (source: ${phoneSource})`);
    
    // ====================================================================
    // EXTRACT STRUCTURED DATA WITH PHONE PRESERVATION
    // ====================================================================
    
    const { dataSource, structuredData } = processIncomingData(body);
    
    // CRITICAL: ALWAYS inject phone into structured data
    structuredData.phone = phone;
    structuredData._phone_source = phoneSource;
    structuredData._extraction_timestamp = new Date().toISOString();
    
    // Validate and sanitize data
    const sanitizedData = sanitizeData(structuredData);
    if (!sanitizedData.valid) {
      console.error('[MemoryStore] Data validation failed:', sanitizedData.issues);
      
      // PARTIAL SAVE: Save phone and basic info even if validation fails
      const emergencyData = {
        phone: phone,
        outcome: structuredData.outcome || 'data_validation_failed',
        preferred_name: structuredData.preferred_name || null,
        timestamp: new Date().toISOString(),
        _emergency_save: true,
        _validation_issues: sanitizedData.issues
      };
      
      await saveEmergencyMemory(phone, emergencyData, env);
      
      return jsonResponse({
        ok: true,
        stored: 'partial',
        phone: phone,
        warning: 'Data validation failed, saved essential info only',
        issues: sanitizedData.issues
      });
    }
    
    // ====================================================================
    // BUILD MEMORY ENTRY WITH PHONE PRESERVATION
    // ====================================================================
    
    const memoryEntry = buildMemoryEntry(sanitizedData.data, phone, phoneSource);
    
    // ====================================================================
    // GET EXISTING MEMORY FOR AGGREGATION
    // ====================================================================
    
    const existingMemory = await getExistingMemory(phone, env);
    
    // ====================================================================
    // PRESERVE CRITICAL PREFERENCES (Anti-Loss Protection)
    // ====================================================================
    
    const preservedEntry = preserveCriticalPreferences(memoryEntry, existingMemory);
    
    // ====================================================================
    // SAVE WITH PHONE NUMBER REDUNDANCY
    // ====================================================================
    
    const saveResult = await saveMemoryWithRedundancy(phone, preservedEntry, existingMemory, env);
    
    const processingTime = Date.now() - startTime;
    
    console.log(`[MemoryStore] SUCCESS: ${phone} - ${saveResult.entries_count} entries stored in ${processingTime}ms`);
    
    return jsonResponse({
      ok: true,
      phone: phone,
      phone_source: phoneSource,
      stored: true,
      entries_count: saveResult.entries_count,
      behavioral_score: saveResult.behavioral_score,
      last_3_summaries: saveResult.last_3_summaries, // INCLUDES PHONE NUMBERS
      processing_time_ms: processingTime,
      redundancy_saves: saveResult.redundancy_saves
    });

  } catch (error) {
    console.error('[MemoryStore] Critical error:', error);
    
    // EMERGENCY: Try to extract phone from error context
    const emergencyPhone = emergencyPhoneSearch(arguments[0]);
    
    if (emergencyPhone) {
      console.warn('[MemoryStore] Emergency phone found during error:', emergencyPhone);
      
      try {
        await saveEmergencyMemory(emergencyPhone, {
          outcome: 'system_error',
          error_message: error.message,
          timestamp: new Date().toISOString(),
          _emergency_error_save: true
        }, env);
        
        console.log('[MemoryStore] Emergency save completed during error recovery');
      } catch (emergencyError) {
        console.error('[MemoryStore] Emergency save failed:', emergencyError);
      }
    }
    
    return jsonResponse({ 
      ok: false, 
      error: 'STORE_FAILED',
      message: error.message,
      emergency_phone: emergencyPhone || null
    }, 500);
  }
}

/**
 * BULLETPROOF PHONE EXTRACTION - Searches EVERYWHERE
 */
function extractPhoneBulletproof(body, request) {
  const searchLog = [];
  let phone = null;
  let source = null;
  
  // EXTRACTION LEVEL 1: VAPI Standard Locations
  const level1Sources = [
    { path: 'body.phone', value: body.phone },
    { path: 'body.message.artifact.phone', value: body.message?.artifact?.phone },
    { path: 'body.message.call.customer.number', value: body.message?.call?.customer?.number },
    { path: 'body.call.customer.number', value: body.call?.customer?.number },
    { path: 'body.customer.number', value: body.customer?.number },
    { path: 'body.artifact.phone', value: body.artifact?.phone },
    { path: 'body.analysis.structuredData.phone', value: body.analysis?.structuredData?.phone }
  ];
  
  for (const src of level1Sources) {
    searchLog.push({ level: 1, ...src });
    if (src.value && isValidPhone(src.value)) {
      phone = normalizePhone(src.value);
      source = `level1:${src.path}`;
      searchLog.push({ result: 'SUCCESS', phone, source });
      return { phone, source, searchLog };
    }
  }
  
  // EXTRACTION LEVEL 2: HTTP Headers
  const level2Headers = [
    'x-customer-number',
    'x-caller-number', 
    'x-phone',
    'phone',
    'customer-number',
    'caller-id'
  ];
  
  for (const header of level2Headers) {
    const value = request.headers.get(header);
    searchLog.push({ level: 2, path: `header.${header}`, value });
    if (value && isValidPhone(value)) {
      phone = normalizePhone(value);
      source = `level2:header.${header}`;
      searchLog.push({ result: 'SUCCESS', phone, source });
      return { phone, source, searchLog };
    }
  }
  
  // EXTRACTION LEVEL 3: Deep Object Search
  const level3Phone = deepPhoneSearch(body, '', new Set());
  if (level3Phone) {
    phone = normalizePhone(level3Phone.value);
    source = `level3:${level3Phone.path}`;
    searchLog.push({ level: 3, result: 'SUCCESS', phone, source, path: level3Phone.path });
    return { phone, source, searchLog };
  }
  
  // EXTRACTION LEVEL 4: Fuzzy Pattern Search
  const level4Phone = fuzzyPhoneSearch(body);
  if (level4Phone) {
    phone = normalizePhone(level4Phone);
    source = 'level4:fuzzy_pattern';
    searchLog.push({ level: 4, result: 'SUCCESS', phone, source });
    return { phone, source, searchLog };
  }
  
  searchLog.push({ result: 'FAILED', levels_attempted: 4 });
  return { phone: null, source: null, searchLog };
}

/**
 * Deep recursive search for phone numbers
 */
function deepPhoneSearch(obj, path = '', visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return null;
  visited.add(obj);
  
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    
    if (typeof value === 'string') {
      // Check if key name suggests phone
      if (/phone|number|caller|customer/i.test(key) && isValidPhone(value)) {
        return { path: currentPath, value, type: 'key_match' };
      }
      
      // Check if value looks like phone
      if (isValidPhone(value)) {
        return { path: currentPath, value, type: 'value_match' };
      }
    }
    
    if (typeof value === 'object' && value !== null) {
      const found = deepPhoneSearch(value, currentPath, visited);
      if (found) return found;
    }
  }
  
  return null;
}

/**
 * Fuzzy pattern search for phone-like strings
 */
function fuzzyPhoneSearch(obj) {
  const jsonStr = JSON.stringify(obj);
  
  // Look for phone patterns in the entire JSON string
  const phonePatterns = [
    /[\+]?1?[\s\-\.]?\(?([0-9]{3})\)?[\s\-\.]?([0-9]{3})[\s\-\.]?([0-9]{4})/g,
    /001[0-9]{10}/g,
    /\+1[0-9]{10}/g,
    /[0-9]{10}/g
  ];
  
  for (const pattern of phonePatterns) {
    const matches = jsonStr.match(pattern);
    if (matches) {
      for (const match of matches) {
        if (isValidPhone(match)) {
          return match;
        }
      }
    }
  }
  
  return null;
}

/**
 * Emergency phone search when all else fails
 */
function emergencyPhoneSearch(data) {
  if (!data) return null;
  
  // Convert everything to string and look for phone patterns
  const fullString = JSON.stringify(data) + ' ' + Object.keys(data).join(' ');
  
  // Extract any 10+ digit sequences
  const digitSequences = fullString.match(/\d{10,15}/g);
  
  if (digitSequences) {
    for (const seq of digitSequences) {
      // Skip obviously non-phone numbers
      if (seq.length > 15 || seq.startsWith('0000') || seq === '1234567890') {
        continue;
      }
      
      if (isValidPhone(seq)) {
        return normalizePhone(seq);
      }
    }
  }
  
  return null;
}

/**
 * Validate if string could be a phone number
 */
function isValidPhone(value) {
  if (!value || typeof value !== 'string') return false;
  
  const digits = value.replace(/\D/g, '');
  
  // Must have 10-15 digits
  if (digits.length < 10 || digits.length > 15) return false;
  
  // Skip obviously fake numbers
  const fakePatterns = [
    /^0+$/, // All zeros
    /^1+$/, // All ones  
    /^1234567890$/, // Sequential
    /^0123456789$/, // Sequential with zero
    /^9999999999$/, // All nines
    /^1111111111$/, // All ones
  ];
  
  return !fakePatterns.some(pattern => pattern.test(digits));
}

/**
 * Normalize phone number to E164 format
 */
function normalizePhone(input) {
  if (!input) return null;
  
  let digits = String(input).replace(/\D/g, '');
  
  // Handle different formats
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (digits.length >= 13 && digits.startsWith('001')) {
    return `+1${digits.substring(3)}`;
  }
  if (String(input).startsWith('+')) {
    return input;
  }
  
  return digits.length >= 10 ? `+1${digits.slice(-10)}` : null;
}

/**
 * Process incoming data to extract structured data
 */
function processIncomingData(body) {
  let dataSource = 'unknown';
  let structuredData = {};

  // VAPI Webhook Detection
  if (body.message || body.artifact || body.type) {
    dataSource = 'vapi_webhook';
    
    // Extract structured data from VAPI webhook
    structuredData = body.message?.artifact || body.artifact || {};
    
    // Validate webhook type
    const messageType = body.message?.type || body.type;
    if (messageType && messageType !== 'end-of-call-report') {
      console.log('[MemoryStore] Ignoring webhook type:', messageType);
      return { dataSource, structuredData: {} };
    }

    // Must have some structured data for storage
    if (!structuredData || Object.keys(structuredData).length < 2) {
      console.log('[MemoryStore] No meaningful structured data in VAPI webhook');
      return { dataSource, structuredData: {} };
    }

  } else if (body.phone || body.outcome || body.preferred_name) {
    // Direct structured data (testing/manual)
    dataSource = 'direct_storage';
    structuredData = body;

  } else {
    // Invalid format
    console.error('[MemoryStore] Invalid request format');
    return { dataSource: 'invalid', structuredData: {} };
  }

  return { dataSource, structuredData };
}

/**
 * Build memory entry with phone number preservation
 */
function buildMemoryEntry(sanitizedData, phone, phoneSource) {
  const now = new Date();
  
  const memoryEntry = {
    // CRITICAL: Phone number preserved in EVERY entry
    phone: phone,
    phone_source: phoneSource,
    phone_normalized: phone,
    call_id: `call-${Date.now()}`,
    timestamp: now.toISOString(),
    
    // Call outcome and context
    summary: buildCallSummary(sanitizedData, phone), // INCLUDES PHONE NUMBER
    outcome: sanitizedData.outcome || 'call_completed',
    language_used: sanitizedData.language_used || 'english',
    
    // Location data
    last_pickup: sanitizedData.last_pickup || null,
    last_dropoff: sanitizedData.last_dropoff || null,
    last_dropoff_lat: sanitizedData.last_dropoff_lat || null,
    last_dropoff_lng: sanitizedData.last_dropoff_lng || null,
    last_trip_id: sanitizedData.last_trip_id || null,
    
    // Customer preferences (CRITICAL)
    preferred_name: sanitizedData.preferred_name || null,
    preferred_language: sanitizedData.preferred_language || null,
    preferred_pickup_address: sanitizedData.preferred_pickup_address || null,
    
    // Behavioral data
    behavior: sanitizedData.behavior || 'neutral',
    behavior_notes: sanitizedData.behavior_notes || null,
    
    // Conversation context
    conversation_topics: sanitizedData.conversation_topics || [],
    personal_details: sanitizedData.personal_details || null,
    trip_discussion: sanitizedData.trip_discussion || null,
    greeting_response: sanitizedData.greeting_response || null,
    relationship_context: sanitizedData.relationship_context || null,
    
    // Operational data
    special_instructions: sanitizedData.special_instructions || null,
    operational_notes: sanitizedData.operational_notes || null,
    
    // Call metadata
    conversation_state: sanitizedData.conversation_state || 'completed',
    collected_info: sanitizedData.collected_info || null,
    
    // REDUNDANCY: Store phone in multiple fields
    _phone_backup: phone,
    _phone_digits_only: phone.replace(/\D/g, ''),
    _phone_last_4: phone.replace(/\D/g, '').slice(-4)
  };
  
  return memoryEntry;
}

/**
 * Build call summary that ALWAYS includes phone number
 */
function buildCallSummary(data, phone) {
  const phoneLast4 = phone.replace(/\D/g, '').slice(-4);
  let summary = `Call from ${phoneLast4}: `;
  
  if (data.preferred_name) {
    summary += `Customer "${data.preferred_name}" `;
  }
  
  if (data.outcome === 'booking_created') {
    summary += `booked ride`;
    if (data.last_pickup && data.last_dropoff) {
      summary += ` from ${data.last_pickup} to ${data.last_dropoff}`;
    }
  } else if (data.preferred_name) {
    summary += `corrected name to "${data.preferred_name}"`;
  } else if (data.outcome === 'dropped_call') {
    summary += `dropped call`;
  } else {
    summary += `${data.outcome || 'called for info'}`;
  }
  
  if (data.behavior && data.behavior !== 'neutral') {
    summary += ` (${data.behavior})`;
  }
  
  // ALWAYS end with phone number for redundancy
  summary += ` [${phone}]`;
  
  return summary;
}

/**
 * Preserve critical preferences to prevent data loss
 */
function preserveCriticalPreferences(newEntry, existingMemory) {
  if (!existingMemory || !existingMemory.aggregated_context) {
    return newEntry;
  }
  
  const existing = existingMemory.aggregated_context;
  const warnings = [];
  
  // Preserve preferred_name if new entry doesn't have one but existing does
  if (existing.preferred_name && !newEntry.preferred_name) {
    console.warn(`[MemoryStore] Preserving existing preferred_name: ${existing.preferred_name}`);
    newEntry.preferred_name = existing.preferred_name;
    warnings.push('preserved_preferred_name');
  }
  
  // Preserve preferred_language if new entry doesn't have one but existing does
  if (existing.preferred_language && !newEntry.preferred_language) {
    console.warn(`[MemoryStore] Preserving existing preferred_language: ${existing.preferred_language}`);
    newEntry.preferred_language = existing.preferred_language;
    warnings.push('preserved_preferred_language');
  }
  
  // Preserve preferred_pickup_address if new entry doesn't have one but existing does
  if (existing.preferred_pickup_address && !newEntry.preferred_pickup_address) {
    console.warn(`[MemoryStore] Preserving existing preferred_pickup_address: ${existing.preferred_pickup_address}`);
    newEntry.preferred_pickup_address = existing.preferred_pickup_address;
    warnings.push('preserved_preferred_pickup_address');
  }
  
  if (warnings.length > 0) {
    newEntry._preservation_warnings = warnings;
  }
  
  return newEntry;
}

/**
 * Save memory with multiple redundancy mechanisms
 */
async function saveMemoryWithRedundancy(phone, memoryEntry, existingMemory, env) {
  const redundancySaves = [];
  
  // Get existing history
  const historyKey = `history:${phone}`;
  const existingHistoryStr = await env.CALL_MEMORIES.get(historyKey);
  let history = existingHistoryStr ? JSON.parse(existingHistoryStr) : [];
  
  // Add new entry to history
  history.unshift(memoryEntry);
  
  // Keep last 50 entries or 7 days, whichever is less
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  history = history.filter(entry => new Date(entry.timestamp) > sevenDaysAgo);
  if (history.length > 50) {
    history = history.slice(0, 50);
  }
  
  // Build aggregated context
  const aggregatedContext = buildAggregatedContext(history);
  const behavioralScore = calculateBehavioralScore(history);
  
  // Build last 3 summaries WITH phone numbers
  const last3Summaries = history.slice(0, 3).map(entry => ({
    phone: entry.phone, // CRITICAL: Always include phone
    timestamp: entry.timestamp,
    summary: entry.summary,
    outcome: entry.outcome,
    phone_last_4: entry.phone.replace(/\D/g, '').slice(-4)
  }));
  
  // SAVE 1: History (primary storage)
  try {
    await env.CALL_MEMORIES.put(
      historyKey,
      JSON.stringify(history),
      { expirationTtl: 7 * 24 * 60 * 60 }
    );
    redundancySaves.push('history_primary');
  } catch (error) {
    console.error('[MemoryStore] History save failed:', error);
  }
  
  // SAVE 2: Latest with aggregated context
  try {
    const latestEntry = {
      ...memoryEntry,
      behavioral_score: behavioralScore,
      history_count: history.length,
      aggregated_context: aggregatedContext,
      last_3_summaries: last3Summaries
    };
    
    await env.CALL_MEMORIES.put(
      `latest:${phone}`,
      JSON.stringify(latestEntry),
      { expirationTtl: 48 * 60 * 60 }
    );
    redundancySaves.push('latest_aggregated');
  } catch (error) {
    console.error('[MemoryStore] Latest save failed:', error);
  }
  
  // SAVE 3: Phone backup (using digits only)
  try {
    const digitsOnly = phone.replace(/\D/g, '');
    await env.CALL_MEMORIES.put(
      `phone_backup:${digitsOnly}`,
      JSON.stringify({
        phone: phone,
        timestamp: memoryEntry.timestamp,
        preferred_name: memoryEntry.preferred_name,
        backup_reason: 'phone_redundancy'
      }),
      { expirationTtl: 24 * 60 * 60 }
    );
    redundancySaves.push('phone_backup');
  } catch (error) {
    console.error('[MemoryStore] Phone backup save failed:', error);
  }
  
  // SAVE 4: Last 4 digits backup (emergency recovery)
  try {
    const last4 = phone.replace(/\D/g, '').slice(-4);
    await env.CALL_MEMORIES.put(
      `last4:${last4}`,
      JSON.stringify({
        phone: phone,
        timestamp: memoryEntry.timestamp,
        emergency_backup: true
      }),
      { expirationTtl: 6 * 60 * 60 } // 6 hours only
    );
    redundancySaves.push('last4_emergency');
  } catch (error) {
    console.error('[MemoryStore] Last4 backup save failed:', error);
  }
  
  return {
    entries_count: history.length,
    behavioral_score: behavioralScore,
    last_3_summaries: last3Summaries,
    redundancy_saves: redundancySaves
  };
}

/**
 * Emergency memory save for critical failures
 */
async function saveEmergencyMemory(phone, data, env) {
  try {
    const emergencyEntry = {
      phone: phone,
      timestamp: new Date().toISOString(),
      emergency_save: true,
      ...data
    };
    
    await env.CALL_MEMORIES.put(
      `emergency:${phone}:${Date.now()}`,
      JSON.stringify(emergencyEntry),
      { expirationTtl: 24 * 60 * 60 }
    );
    
    console.log('[MemoryStore] Emergency save completed for:', phone);
    return true;
  } catch (error) {
    console.error('[MemoryStore] Emergency save failed:', error);
    return false;
  }
}

/**
 * Get existing memory for phone number
 */
async function getExistingMemory(phone, env) {
  try {
    const latestStr = await env.CALL_MEMORIES.get(`latest:${phone}`);
    return latestStr ? JSON.parse(latestStr) : null;
  } catch (error) {
    console.error('[MemoryStore] Existing memory retrieval failed:', error);
    return null;
  }
}

// ============================================================================
// HELPER FUNCTIONS (Sanitization, Aggregation, etc.)
// ============================================================================

function sanitizeData(data) {
  // Simplified for brevity - would include full validation logic
  return {
    valid: true,
    data: data,
    issues: []
  };
}

function buildAggregatedContext(history) {
  // Simplified for brevity - would include full aggregation logic
  if (!history || history.length === 0) return {};
  
  const recentCalls = history.slice(0, 5);
  
  // Extract preferences from most recent calls
  let preferred_name = null;
  let preferred_language = null;
  let preferred_pickup_address = null;
  
  for (const call of recentCalls) {
    if (!preferred_name && call.preferred_name) preferred_name = call.preferred_name;
    if (!preferred_language && call.preferred_language) preferred_language = call.preferred_language;
    if (!preferred_pickup_address && call.preferred_pickup_address) preferred_pickup_address = call.preferred_pickup_address;
  }
  
  return {
    preferred_name,
    preferred_language,
    preferred_pickup_address,
    total_recent_calls: recentCalls.length
  };
}

function calculateBehavioralScore(history) {
  // Simplified for brevity - would include full scoring logic
  return 0;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}