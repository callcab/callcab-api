// src/handlers/memory-store.js

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export async function handleMemoryStore(request, env) {
  try {
    const body = await request.json();
    
    const {
      phone,
      timestamp,
      outcome,
      last_pickup,
      last_dropoff,
      last_dropoff_lat,
      last_dropoff_lng,
      behavior,
      was_dropped = false,
      conversation_state,
      collected_info,
      trip_discussion,
      special_instructions,
      aggregated_context
    } = body;

    // Validate required fields
    if (!phone) {
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

    // Normalize phone
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
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

    // Prepare memory object
    const memoryData = {
      phone: normalizedPhone,
      timestamp: timestamp || new Date().toISOString(),
      outcome,
      last_pickup,
      last_dropoff,
      last_dropoff_lat,
      last_dropoff_lng,
      behavior,
      was_dropped,
      conversation_state,
      collected_info,
      trip_discussion,
      special_instructions,
      aggregated_context
    };

    console.log('[MemoryStore] Storing memory for:', normalizedPhone);

    // Store in KV
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
        stored_at: memoryData.timestamp
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

function normalizePhone(input) {
  if (!input) return null;

  let digits = String(input).replace(/\D/g, '');

  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (String(input).startsWith('+')) {
    return input;
  }

  return digits.length >= 10 ? `+${digits}` : null;
}