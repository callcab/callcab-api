// src/handlers/memory-store.js

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// In-memory deduplication cache (simple approach)
const recentStores = new Map();
const DEDUPE_WINDOW_MS = 30000; // 30 seconds

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
      aggregated_context,
      call_id // Add this to identify unique calls
    } = body;

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

    // DEDUPLICATION: Check if we recently stored for this phone
    const dedupeKey = call_id || normalizedPhone;
    const lastStore = recentStores.get(dedupeKey);
    const now = Date.now();
    
    if (lastStore && (now - lastStore) < DEDUPE_WINDOW_MS) {
      const secondsAgo = Math.round((now - lastStore) / 1000);
      console.log(`[MemoryStore] DEDUPE: Ignoring duplicate store for ${normalizedPhone} (${secondsAgo}s ago)`);
      
      return new Response(
        JSON.stringify({
          ok: true,
          deduplicated: true,
          phone: normalizedPhone,
          message: `Already stored ${secondsAgo} seconds ago`,
          last_stored: new Date(lastStore).toISOString()
        }),
        {
          status: 200,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
        }
      );
    }

    // Prepare memory object
    const memoryData = {
      phone: normalizedPhone,
      timestamp: timestamp || new Date().toISOString(),
      call_id,
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

    console.log('[MemoryStore] Storing memory for:', normalizedPhone, {
      outcome,
      has_aggregated: !!aggregated_context,
      was_dropped,
      call_id
    });

    // Store in KV
    await env.CALL_MEMORIES.put(
      `latest:${normalizedPhone}`,
      JSON.stringify(memoryData),
      {
        expirationTtl: 60 * 60 * 24 * 90 // 90 days
      }
    );

    // Update deduplication cache
    recentStores.set(dedupeKey, now);
    
    // Clean up old entries (simple garbage collection)
    if (recentStores.size > 100) {
      const cutoff = now - DEDUPE_WINDOW_MS;
      for (const [key, time] of recentStores.entries()) {
        if (time < cutoff) {
          recentStores.delete(key);
        }
      }
    }

    console.log('[MemoryStore] Successfully stored memory');

    return new Response(
      JSON.stringify({
        ok: true,
        phone: normalizedPhone,
        stored_at: memoryData.timestamp,
        expires_in_days: 90,
        call_id
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
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(input).startsWith('+')) return input;
  return digits.length >= 10 ? `+${digits}` : null;
}