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
    
    // Extract phone from various possible locations (OpenSesame wrapper compatibility)
    const phone = body.phone || 
                  body.customer?.number || 
                  body.call?.customer?.number ||
                  body.memory?.phone;
    
    if (!phone) {
      console.error('[MemoryStore] MISSING_PHONE');
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'MISSING_PHONE',
          message: 'Phone number is required'
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
      
      // Behavioral data
      behavior: body.behavior || null,
      was_dropped: body.was_dropped || false,
      
      // Conversation state
      conversation_state: body.conversation_state || null,
      collected_info: body.collected_info || null,
      trip_discussion: body.trip_discussion || null,
      special_instructions: body.special_instructions || null,
      
      // Aggregated context (preferences)
      aggregated_context: body.aggregated_context || null
    };

    // Remove null values to keep storage lean
    Object.keys(memoryData).forEach(key => {
      if (memoryData[key] === null || memoryData[key] === undefined) {
        delete memoryData[key];
      }
    });

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
        message: error.message
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
      }
    );
  }
}

/**
 * Normalize phone number to E.164 format
 */
function normalizePhone(input) {
  if (!input) return null;

  let digits = String(input).replace(/\D/g, '');

  // 10-digit US number
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // 11-digit with leading 1
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  // Already has + prefix
  if (String(input).startsWith('+')) {
    return input;
  }

  // Any other format with 10+ digits
  return digits.length >= 10 ? `+${digits}` : null;
}