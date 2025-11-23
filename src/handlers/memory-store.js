// src/handlers/memory-store.js

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Store call memory - ONLY processes end-of-call webhooks with structured data
 * Ignores all other Vapi webhook types (status-update, hang, etc)
 */
export async function handleMemoryStore(request, env) {
  try {
    const body = await request.json();
    
    // CRITICAL: Filter webhook types - only process end-of-call with structured data
    const messageType = body.message?.type || body.type;
    
    // Ignore non-end-of-call webhooks
    if (messageType && messageType !== 'end-of-call-report') {
      console.log('[MemoryStore] Ignoring webhook type:', messageType);
      return new Response(
        JSON.stringify({ ok: true, ignored: true, reason: 'Not end-of-call webhook' }),
        { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    
    // Check if structured data exists (only present at end-of-call)
    const structuredData = body.message?.artifact || body.artifact || body;
    
    if (!structuredData || Object.keys(structuredData).length < 3) {
      console.log('[MemoryStore] No structured data, ignoring');
      return new Response(
        JSON.stringify({ ok: true, ignored: true, reason: 'No structured data' }),
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
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'MISSING_PHONE',
          message: 'Phone not found in structured data',
          hint: 'Ensure phone field is in Vapi structured data schema'
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
          message: 'Invalid phone number format'
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

    // Build aggregated_context separately (THIS IS THE KEY PART FOR PREFERENCES)
    const aggregatedContext = {};
    
    if (structuredData.preferred_name) {
      aggregatedContext.preferred_name = structuredData.preferred_name;
    }
    
    if (structuredData.preferred_language) {
      aggregatedContext.preferred_language = structuredData.preferred_language;
    }
    
    if (structuredData.preferred_pickup_address) {
      aggregatedContext.preferred_pickup_address = structuredData.preferred_pickup_address;
    }
    
    // Only add aggregated_context if it has data
    if (Object.keys(aggregatedContext).length > 0) {
      memoryData.aggregated_context = aggregatedContext;
    }

    // Remove null/empty values from top level
    Object.keys(memoryData).forEach(key => {
      if (memoryData[key] === null || memoryData[key] === undefined || 
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

    console.log('[MemoryStore] Storing memory for:', normalizedPhone, {
      outcome: memoryData.outcome,
      has_aggregated: !!memoryData.aggregated_context,
      aggregated_keys: memoryData.aggregated_context ? Object.keys(memoryData.aggregated_context) : [],
      fields_stored: Object.keys(memoryData).length
    });

    // Store in KV
    await env.CALL_MEMORIES.put(
      `latest:${normalizedPhone}`,
      JSON.stringify(memoryData),
      { expirationTtl: 60 * 60 * 24 * 90 }
    );

    console.log('[MemoryStore] ✓ Memory saved successfully');

    return new Response(
      JSON.stringify({
        ok: true,
        phone: normalizedPhone,
        stored_at: memoryData.timestamp,
        fields_stored: Object.keys(memoryData).length,
        expires_in_days: 90
      }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('[MemoryStore] Error:', error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'STORE_FAILED',
        message: error.message
      }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
}

function normalizePhone(input) {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(input).startsWith('+')) return input;
  return digits.length >= 10 ? `+${digits}` : null;
}