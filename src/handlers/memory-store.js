// src/handlers/memory-store.js

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Store call memory in KV - FILTERS OUT OpenSesame wrapper metadata
 * Only stores the actual memory data sent at end of call
 */
export async function handleMemoryStore(request, env) {
  try {
    const body = await request.json();
    
    // Log full body for debugging
    console.log('[MemoryStore] Received body keys:', Object.keys(body));
    
    // Extract phone from various possible locations (OpenSesame + Vapi compatibility)
    const phone = body.phone || 
                  body.confirmed_phone ||  // From structured data
                  body.customer?.number || 
                  body.customer?.phone ||
                  body.call?.customer?.number ||
                  body.call?.customer?.phone ||
                  body.call?.phoneNumber ||
                  body.phoneNumber ||
                  body.memory?.phone;
    
    if (!phone) {
      console.error('[MemoryStore] MISSING_PHONE - Available fields:', JSON.stringify(body, null, 2));
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'MISSING_PHONE',
          message: 'Phone number is required',
          debug: {
            received_fields: Object.keys(body),
            hint: 'Add phone field to structured data or check Vapi call metadata'
          }
        }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      );
    }

    // Check KV configuration
    if (!env.CALL_MEMORIES) {
      console.error('[MemoryStore] CALL_MEMORIES KV not configured');
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'KV_NOT_CONFIGURED',
          message: 'Memory storage is not configured'
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      );
    }

    // Normalize phone number
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      console.error('[MemoryStore] INVALID_PHONE:', phone);
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'INVALID_PHONE',
          message: 'Invalid phone number format'
        }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      );
    }

    // FILTER: Only extract memory-specific fields, ignore OpenSesame metadata
    const memoryData = {
      phone: normalizedPhone,
      timestamp: body.timestamp || new Date().toISOString(),
      
      // Call outcome
      outcome: body.outcome || null,
      
      // Location data
      last_pickup: body.last_pickup || null,
      last_dropoff: body.last_dropoff || null,
      last_dropoff_lat: body.last_dropoff_lat || null,
      last_dropoff_lng: body.last_dropoff_lng || null,
      last_trip_id: body.last_trip_id || null,
      
      // Behavioral data
      behavior: body.behavior || null,
      behavior_notes: body.behavior_notes || null,
      was_dropped: body.was_dropped || false,
      
      // Conversation state
      conversation_state: body.conversation_state || null,
      collected_info: body.collected_info || null,
      trip_discussion: body.trip_discussion || null,
      special_instructions: body.special_instructions || null,
      
      // Personal context
      conversation_topics: body.conversation_topics || null,
      jokes_shared: body.jokes_shared || null,
      personal_details: body.personal_details || null,
      greeting_response: body.greeting_response || null,
      relationship_context: body.relationship_context || null,
      operational_notes: body.operational_notes || null,
      special_notes: body.special_notes || null,
      
      // Callback info
      callback_confirmed: body.callback_confirmed || null,
      
      // Aggregated context (preferences) - CRITICAL for preservation
      aggregated_context: {
        preferred_name: body.preferred_name || null,
        preferred_language: body.preferred_language || null,
        preferred_pickup_address: body.preferred_pickup_address || null,
        behavioral_pattern: body.behavioral_pattern || null
      }
    };

    // Remove null values to keep storage lean
    Object.keys(memoryData).forEach(key => {
      if (memoryData[key] === null || memoryData[key] === undefined) {
        delete memoryData[key];
      }
    });
    
    // Clean up aggregated_context
    if (memoryData.aggregated_context) {
      Object.keys(memoryData.aggregated_context).forEach(key => {
        if (memoryData.aggregated_context[key] === null || 
            memoryData.aggregated_context[key] === undefined) {
          delete memoryData.aggregated_context[key];
        }
      });
      
      // Remove if empty
      if (Object.keys(memoryData.aggregated_context).length === 0) {
        delete memoryData.aggregated_context;
      }
    }

    console.log('[MemoryStore] Storing filtered memory for:', normalizedPhone, {
      outcome: memoryData.outcome,
      has_aggregated: !!memoryData.aggregated_context,
      was_dropped: memoryData.was_dropped,
      fields_stored: Object.keys(memoryData).length
    });

    // Store in KV with 90-day expiration
    await env.CALL_MEMORIES.put(
      `latest:${normalizedPhone}`,
      JSON.stringify(memoryData),
      {
        expirationTtl: 60 * 60 * 24 * 90 // 90 days
      }
    );

    console.log('[MemoryStore] Successfully stored memory');

    return new Response(
      JSON.stringify({
        ok: true,
        phone: normalizedPhone,
        stored_at: memoryData.timestamp,
        fields_stored: Object.keys(memoryData).length,
        expires_in_days: 90
      }),
      {
        status: 200,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      }
    );

  } catch (error) {
    console.error('[MemoryStore] Error:', error);
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'STORE_FAILED',
        message: error.message,
        stack: env.DEBUG ? error.stack : undefined
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      }
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