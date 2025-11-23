// src/handlers/memory-store.js
// Production version - stores call memory from VAPI end-of-call webhooks

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Store call memory - ONLY processes end-of-call webhooks with structured data
 * Ignores all other Vapi webhook types (status-update, hang, etc)
 * 
 * Stores TWO KV entries per call:
 * 1. latest:{phone} - Most recent call (overwritten each time)
 * 2. history:{phone}:{timestamp} - Historical record (preserved for 90 days)
 */
export async function handleMemoryStore(request, env) {
  try {
    const body = await request.json();
    
    // SECURITY: Verify this is a legitimate VAPI webhook
    // Check for VAPI-specific structure
    if (!body.message && !body.artifact && !body.type) {
      console.error('[MemoryStore] SECURITY: Invalid webhook structure');
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'INVALID_WEBHOOK',
          message: 'Not a valid VAPI webhook'
        }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    
    // CRITICAL: Filter webhook types - only process end-of-call with structured data
    const messageType = body.message?.type || body.type;
    
    // Ignore non-end-of-call webhooks (status-update, hang, etc)
    if (messageType && messageType !== 'end-of-call-report') {
      console.log('[MemoryStore] Ignoring webhook type:', messageType);
      return new Response(
        JSON.stringify({ 
          ok: true, 
          ignored: true, 
          reason: 'Not end-of-call webhook',
          type: messageType 
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    
    // Check if structured data exists (only present at end-of-call)
    const structuredData = body.message?.artifact || body.artifact || body;
    
    if (!structuredData || Object.keys(structuredData).length < 3) {
      console.log('[MemoryStore] No structured data, ignoring');
      return new Response(
        JSON.stringify({ 
          ok: true, 
          ignored: true, 
          reason: 'No structured data',
          keys_found: Object.keys(structuredData || {}).length 
        }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    
    // Extract phone from multiple possible locations
    const phone = structuredData.phone || 
                  body.message?.call?.customer?.number ||
                  body.call?.customer?.number ||
                  body.customer?.number;
    
    if (!phone) {
      console.error('[MemoryStore] MISSING_PHONE in structured data');
      console.error('[MemoryStore] Available keys:', Object.keys(structuredData));
      console.error('[MemoryStore] Body structure:', JSON.stringify(body, null, 2).substring(0, 500));
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'MISSING_PHONE',
          message: 'Phone not found in structured data',
          hint: 'Ensure phone field is in VAPI structured data schema',
          available_keys: Object.keys(structuredData)
        }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    if (!env.CALL_MEMORIES) {
      console.error('[MemoryStore] CALL_MEMORIES KV not configured');
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'KV_NOT_CONFIGURED',
          message: 'Memory storage is not configured'
        }),
        { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      console.error('[MemoryStore] INVALID_PHONE:', phone);
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'INVALID_PHONE',
          message: 'Invalid phone number format',
          provided: phone
        }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }

    // Build memory object from structured data
    const memoryData = {
      phone: normalizedPhone,
      timestamp: new Date().toISOString(),
      
      // Call outcome
      outcome: structuredData.outcome || null,
      language_used: structuredData.language_used || null,
      
      // Location data (only if booking completed)
      last_pickup: structuredData.last_pickup || null,
      last_dropoff: structuredData.last_dropoff || null,
      last_dropoff_lat: structuredData.last_dropoff_lat || null,
      last_dropoff_lng: structuredData.last_dropoff_lng || null,
      last_trip_id: structuredData.last_trip_id || null,
      
      // Behavioral data
      behavior: structuredData.behavior || null,
      behavior_notes: structuredData.behavior_notes || null,
      was_dropped: structuredData.outcome === 'dropped_call',
      
      // Conversation state
      conversation_state: structuredData.conversation_state || null,
      collected_info: structuredData.collected_info || null,
      trip_discussion: structuredData.trip_discussion || null,
      
      // Personal context
      greeting_response: structuredData.greeting_response || null,
      relationship_context: structuredData.relationship_context || null,
      conversation_topics: structuredData.conversation_topics || null,
      jokes_shared: structuredData.jokes_shared || null,
      personal_details: structuredData.personal_details || null,
      
      // Operational notes
      special_instructions: structuredData.special_instructions || null,
      operational_notes: structuredData.operational_notes || null,
      special_notes: structuredData.special_notes || null,
      
      // Callback
      callback_confirmed: structuredData.callback_confirmed || false
    };

    // Build aggregated_context separately (CRITICAL FOR PREFERENCES)
    // These fields persist across calls unless explicitly updated
    const aggregatedContext = {};
    
    if (structuredData.preferred_name) {
      aggregatedContext.preferred_name = structuredData.preferred_name.trim();
    }
    
    if (structuredData.preferred_language && structuredData.preferred_language !== 'english') {
      aggregatedContext.preferred_language = structuredData.preferred_language.trim();
    }
    
    if (structuredData.preferred_pickup_address) {
      aggregatedContext.preferred_pickup_address = structuredData.preferred_pickup_address.trim();
    }
    
    // Only add aggregated_context if it has data
    if (Object.keys(aggregatedContext).length > 0) {
      memoryData.aggregated_context = aggregatedContext;
    }

    // Remove null/empty values from top level
    Object.keys(memoryData).forEach(key => {
      if (memoryData[key] === null || 
          memoryData[key] === undefined || 
          memoryData[key] === '' ||
          (Array.isArray(memoryData[key]) && memoryData[key].length === 0)) {
        delete memoryData[key];
      }
    });
    
    // Clean aggregated_context
    if (memoryData.aggregated_context) {
      Object.keys(memoryData.aggregated_context).forEach(key => {
        if (memoryData.aggregated_context[key] === null || 
            memoryData.aggregated_context[key] === undefined ||
            memoryData.aggregated_context[key] === '') {
          delete memoryData.aggregated_context[key];
        }
      });
      
      if (Object.keys(memoryData.aggregated_context).length === 0) {
        delete memoryData.aggregated_context;
      }
    }

    // Clean collected_info
    if (memoryData.collected_info) {
      Object.keys(memoryData.collected_info).forEach(key => {
        if (memoryData.collected_info[key] === null || 
            memoryData.collected_info[key] === undefined ||
            memoryData.collected_info[key] === '') {
          delete memoryData.collected_info[key];
        }
      });
      
      if (Object.keys(memoryData.collected_info).length === 0) {
        delete memoryData.collected_info;
      }
    }

    console.log('[MemoryStore] Storing memory for:', normalizedPhone, {
      outcome: memoryData.outcome,
      has_aggregated: !!memoryData.aggregated_context,
      aggregated_keys: memoryData.aggregated_context ? Object.keys(memoryData.aggregated_context) : [],
      fields_stored: Object.keys(memoryData).length,
      data_size: JSON.stringify(memoryData).length
    });

    // STORE 1: Latest call (overwritten each time)
    await env.CALL_MEMORIES.put(
      `latest:${normalizedPhone}`,
      JSON.stringify(memoryData),
      { expirationTtl: 60 * 60 * 24 * 90 } // 90 days
    );

    // STORE 2: Historical record (preserved)
    const historyKey = `history:${normalizedPhone}:${memoryData.timestamp}`;
    await env.CALL_MEMORIES.put(
      historyKey,
      JSON.stringify(memoryData),
      { expirationTtl: 60 * 60 * 24 * 90 } // 90 days
    );

    console.log('[MemoryStore] ✓ Memory saved successfully (latest + history)');

    return new Response(
      JSON.stringify({
        ok: true,
        phone: normalizedPhone,
        stored_at: memoryData.timestamp,
        fields_stored: Object.keys(memoryData).length,
        data_size_bytes: JSON.stringify(memoryData).length,
        expires_in_days: 90,
        history_stored: true,
        aggregated_context_stored: !!memoryData.aggregated_context
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[MemoryStore] Error:', error);
    console.error('[MemoryStore] Stack:', error.stack);
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'STORE_FAILED',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
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