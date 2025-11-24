// Fixed icabbi-booking.js for Firebase/Cloudflare Workers
// Replicates the working Vercel pattern with Basic Auth

import { jsonResponse } from '../lib/utils.js';

const SERVICE_TZ = "America/Denver";
const DEFAULT_CALLER_NAME = "";
const DEFAULT_CALLER_PHONE = "";

export async function handleIcabbiBooking(request, env) {
  try {
    // Parse JSON body
    const body = await request.json();
    
    const {
      action = "create",
      debug = false,

      // Booking data
      phone,
      customer,              // { phone | number | name }
      callerPhone,
      caller_number,
      name,
      pickup,                // { lat, lng, address? }
      destination,           // { lat, lng, address? }
      date,                  // natural phrases, ISO ±TZ, epoch
      instructions,
      trip_id,
      perma_id,
      status,                // for status_update

      // Optional
      source = "DISPATCH",
      site_id,               // default 74 if omitted
      route_by,              // 'appt' | 'default' (update)
      include_segments,      // boolean for get
      // list filters (for upcoming/active)
      limit,
      page,
      order_by,
      order_dir,
      from,                  // pickup date from
      to,                    // pickup date to
      payment_method,
      vehicle_ref,
      account_only,
      accounts,              // comma-separated account IDs
      account_id,
      user_id,
    } = body;

    // Credentials - EXACTLY like working Vercel version
    const BASE = (env.ICABBI_BASE_URL || "https://api.icabbi.us/us2").replace(/\/+$/, "");
    const APP = env.ICABBI_APP_KEY;
    const SEC = env.ICABBI_SECRET || env.ICABBI_SECRET_KEY;
    
    if (!APP || !SEC) {
      return jsonResponse({
        ok: false,
        error: "MISSING_ICABBI_KEYS",
        message: "Set ICABBI_BASE_URL, ICABBI_APP_KEY, ICABBI_SECRET env vars.",
      }, 500);
    }
    
    // Use Basic Auth like the working version
    const AUTH = btoa(`${APP}:${SEC}`);
    const BASE_HEADERS = {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Basic ${AUTH}`,
    };

    const log = (level, message, data = {}) =>
      console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...data }));

    // Shared phone resolution with default
    const resolvedPhoneE164 =
      normalizePhone(
        phone ||
          customer?.phone ||
          customer?.number ||
          callerPhone ||
          caller_number ||
          body?.rawPhoneDigits ||
          DEFAULT_CALLER_PHONE
      ) || DEFAULT_CALLER_PHONE;

    // Dispatch by action
    if (action === "create" || action === "add") {
      return await handleCreate({
        debug,
        BASE,
        BASE_HEADERS,
        log,
        rawPhone: resolvedPhoneE164,
        name: name || customer?.name || DEFAULT_CALLER_NAME,
        pickup,
        destination,
        date,
        instructions,
        source,
        site_id: site_id ?? 74,
      });
    }

    if (action === "get") {
      return await handleGet({ BASE, BASE_HEADERS, log, trip_id, include_segments, debug });
    }

    if (action === "cancel") {
      return await handleCancel({ BASE, BASE_HEADERS, log, trip_id, debug });
    }

    if (action === "update") {
      return await handleUpdate({
        BASE,
        BASE_HEADERS,
        log,
        trip_id,
        // updatable fields
        phone: resolvedPhoneE164,
        name: name || customer?.name || DEFAULT_CALLER_NAME,
        date,
        pickup,
        destination,
        instructions,
        route_by,
        site_id,
        debug,
      });
    }

    if (action === "status_update") {
      return await handleStatusUpdate({
        BASE,
        BASE_HEADERS,
        log,
        perma_id: perma_id || body?.perma_id,
        status,
        debug,
      });
    }

    if (action === "upcoming") {
      return await handleList({
        BASE,
        BASE_HEADERS,
        log,
        endpoint: "bookings/upcoming",
        query: {
          limit, page, order_by, order_dir, from, to, payment_method,
          vehicle_ref, account_only, include_segments, site_id, account_id,
          accounts, user_id,
          phone: toIcabbiPhone(resolvedPhoneE164), // API expects fleet format
        },
        debug,
      });
    }

    if (action === "upcoming_slim") {
      return await handleList({
        BASE,
        BASE_HEADERS,
        log,
        endpoint: "bookings/upcoming_slim",
        query: {
          limit, page, order_by, order_dir,
          from, to,
          site_id,
          phone: toIcabbiPhone(resolvedPhoneE164),
        },
        debug,
      });
    }

    if (action === "active") {
      return await handleList({
        BASE,
        BASE_HEADERS,
        log,
        endpoint: "bookings/active",
        query: {
          limit, page, order_by, order_dir, payment_method,
          account_only, vehicle_ref, include_segments, accounts,
          phone: toIcabbiPhone(resolvedPhoneE164),
        },
        debug,
      });
    }

    return jsonResponse({ 
      ok: false, 
      error: "INVALID_ACTION", 
      message: `Action '${action}' not supported.` 
    }, 400);
    
  } catch (error) {
    console.error("[icabbi-booking] Fatal:", error);
    return jsonResponse({ 
      ok: false, 
      error: "REQUEST_FAILED", 
      message: error?.message || "Unexpected error" 
    }, 500);
  }
}

// CREATE handler
async function handleCreate(params) {
  const {
    debug, BASE, BASE_HEADERS, log, rawPhone, name, pickup, destination, date, instructions, source, site_id
  } = params;

  // Validate required fields
  if (!rawPhone) {
    return jsonResponse({ ok: false, error: "MISSING_PHONE", message: "Phone number required" }, 400);
  }

  if (!pickup?.lat || !pickup?.lng) {
    return jsonResponse({ ok: false, error: "MISSING_PICKUP", message: "Pickup coordinates required" }, 400);
  }

  if (!destination?.lat || !destination?.lng) {
    return jsonResponse({ ok: false, error: "MISSING_DESTINATION", message: "Destination coordinates required" }, 400);
  }

  // Parse and validate pickup time
  const pickupISO = parseWhenToISO(date);
  if (!pickupISO) {
    return jsonResponse({ ok: false, error: "INVALID_DATE", message: "Could not parse pickup time" }, 400);
  }

  const finalPickupISO = ensureFutureISO(pickupISO, 2);

  // Validate zones
  const [pickupZone, destZone] = await Promise.all([
    validateZone(pickup.lat, pickup.lng, BASE, BASE_HEADERS, log),
    validateZone(destination.lat, destination.lng, BASE, BASE_HEADERS, log),
  ]);

  if (!pickupZone.valid) {
    return jsonResponse({
      ok: false,
      error: "PICKUP_ZONE_INVALID",
      message: `Pickup location not in service area: ${pickupZone.reason}`,
    }, 400);
  }

  if (!destZone.valid) {
    return jsonResponse({
      ok: false,
      error: "DESTINATION_ZONE_INVALID",
      message: `Destination not in service area: ${destZone.reason}`,
    }, 400);
  }

  // Build create request
  const createPayload = {
    phone: toIcabbiPhone(rawPhone),
    passenger_name: name || "",
    pickup_date: finalPickupISO,
    pickup_lat: pickup.lat,
    pickup_lng: pickup.lng,
    pickup_address: pickup.address || `${pickup.lat}, ${pickup.lng}`,
    destination_lat: destination.lat,
    destination_lng: destination.lng,
    destination_address: destination.address || `${destination.lat}, ${destination.lng}`,
    instructions: instructions || "",
    source,
    site_id,
  };

  try {
    const response = await fetch(`${BASE}/bookings/create`, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify(createPayload),
    });

    const data = await safeJson(response);
    const success = response.ok && (data.code === 0 || data.code === "0" || data.code === 200);

    if (!success) {
      return jsonResponse({
        ok: false,
        error: "CREATE_FAILED",
        message: data.message || "Booking creation failed",
        icabbiResponse: debug ? data : undefined,
      }, 400);
    }

    return jsonResponse({
      ok: true,
      created: true,
      trip_id: data.body?.trip_id || data.body?.booking?.trip_id,
      booking: data.body?.booking || data.body,
      debug: debug ? { request: createPayload, response: data } : undefined,
    });

  } catch (error) {
    return jsonResponse({
      ok: false,
      error: "CREATE_ERROR",
      message: error?.message || "Error creating booking",
    }, 500);
  }
}

// GET handler
async function handleGet({ BASE, BASE_HEADERS, log, trip_id, include_segments, debug }) {
  if (!trip_id) {
    return jsonResponse({ ok: false, error: "MISSING_TRIP_ID", message: "Trip ID required" }, 400);
  }

  try {
    const url = `${BASE}/bookings/get/${trip_id}${include_segments ? "?include_segments=1" : ""}`;
    const response = await fetch(url, { method: "GET", headers: BASE_HEADERS });
    const data = await safeJson(response);

    const success = response.ok && (data.code === 0 || data.code === "0" || data.code === 200);
    if (!success) {
      return jsonResponse({
        ok: false,
        error: "GET_FAILED",
        message: data.message || "Failed to get booking",
        icabbiResponse: debug ? data : undefined,
      }, 400);
    }

    return jsonResponse({
      ok: true,
      trip_id,
      booking: data.body?.booking || data.body,
      debug: debug ? { response: data } : undefined,
    });

  } catch (error) {
    return jsonResponse({
      ok: false,
      error: "GET_ERROR",
      message: error?.message || "Error getting booking",
    }, 500);
  }
}

// CANCEL handler
async function handleCancel({ BASE, BASE_HEADERS, log, trip_id, debug }) {
  if (!trip_id) {
    return jsonResponse({ ok: false, error: "MISSING_TRIP_ID", message: "Trip ID required" }, 400);
  }

  try {
    const response = await fetch(`${BASE}/bookings/cancel/${trip_id}`, {
      method: "POST",
      headers: BASE_HEADERS,
    });

    const data = await safeJson(response);
    const success = response.ok && (data.code === 0 || data.code === "0" || data.code === 200);

    if (!success) {
      return jsonResponse({
        ok: false,
        error: "CANCEL_FAILED",
        message: data.message || "Failed to cancel booking",
        icabbiResponse: debug ? data : undefined,
      }, 400);
    }

    return jsonResponse({
      ok: true,
      cancelled: true,
      trip_id,
      debug: debug ? { response: data } : undefined,
    });

  } catch (error) {
    return jsonResponse({
      ok: false,
      error: "CANCEL_ERROR",
      message: error?.message || "Error cancelling booking",
    }, 500);
  }
}

// UPDATE handler (placeholder - implement based on iCabbi API docs)
async function handleUpdate(params) {
  return jsonResponse({ ok: false, error: "NOT_IMPLEMENTED", message: "Update not implemented" }, 501);
}

// STATUS_UPDATE handler (placeholder)
async function handleStatusUpdate(params) {
  return jsonResponse({ ok: false, error: "NOT_IMPLEMENTED", message: "Status update not implemented" }, 501);
}

// LIST handler for upcoming/active bookings
async function handleList({ BASE, BASE_HEADERS, log, endpoint, query, debug }) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) qs.set(k, String(v));
  }

  const url = `${BASE}/${endpoint}${qs.toString() ? `?${qs.toString()}` : ""}`;

  try {
    const response = await fetch(url, { method: "GET", headers: BASE_HEADERS });
    const data = await safeJson(response);
    const success = response.ok && (data.code === 0 || data.code === "0" || data.code === 200);

    if (!success) {
      return jsonResponse({
        ok: false,
        error: "LIST_FAILED",
        message: data.message || `Failed to fetch ${endpoint}`,
        icabbiResponse: debug ? data : undefined,
        requested_url: debug ? url : undefined,
      }, 400);
    }

    return jsonResponse({
      ok: true,
      endpoint,
      total: data.body?.total ?? undefined,
      total_available: data.body?.total_available ?? undefined,
      bookings: data.body?.bookings ?? [],
      debug: debug ? { url, full_response: data } : undefined,
    });

  } catch (error) {
    return jsonResponse({
      ok: false,
      error: "LIST_ERROR",
      message: error?.message || "Unexpected error",
    }, 500);
  }
}

// Utility functions - replicated from working Vercel version
async function validateZone(lat, lng, BASE, BASE_HEADERS, log) {
  try {
    const response = await fetch(`${BASE}/zone/index?lat=${lat}&lng=${lng}`, { 
      method: "GET", 
      headers: BASE_HEADERS 
    });
    const data = await safeJson(response);
    const success = response.ok && (data.code === 0 || data.code === "0");
    
    if (!success || !Array.isArray(data.body?.zones) || data.body.zones.length === 0) {
      return { valid: false, reason: "NO_ZONES" };
    }
    
    const active = data.body.zones.filter((z) => z.active === "1" || z.active === 1);
    if (!active.length) return { valid: false, reason: "NO_ACTIVE_ZONES" };
    
    const available = active.filter((z) => !(z.fully_booked_times?.length));
    if (!available.length) {
      return { valid: false, reason: "ZONES_FULLY_BOOKED", until: active[0]?.fully_booked_times?.[0]?.to };
    }
    
    return { valid: true, primary: available[0] };
  } catch (e) {
    return { valid: false, reason: "VALIDATION_ERROR" };
  }
}

function normalizePhone(input) {
  if (!input) return null;
  let raw = String(input).trim();
  raw = raw.replace(/[^\d+]/g, ""); // keep digits and +
  if (raw.startsWith("001")) raw = "+1" + raw.slice(3);
  if (/^\+\d{7,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length < 7) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 7 && digits <= 15) return `+${digits}`;
  return null;
}

// Convert +E.164 to iCabbi expected "international" form for list filters
function toIcabbiPhone(e164) {
  if (!e164) return undefined;
  const digits = e164.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) return "001" + digits.slice(1);
  // generic: +CC... -> 00CC...
  if (e164.startsWith("+")) return "00" + e164.slice(1);
  return digits;
}

// Parse friendly/ISO-ish/epoch into UTC ISO, assuming SERVICE_TZ wall-clock when no TZ provided
function parseWhenToISO(input) {
  if (input == null) return null;
  let text = String(input).trim();

  // Epoch support
  if (/^\d{10}$/.test(text)) return new Date(parseInt(text, 10) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(parseInt(text, 10)).toISOString();

  const s = text.toLowerCase();
  const now = new Date();

  // Handle "now" variants
  if (/^(now|right now|asap|immediately|soon)$/.test(s)) {
    return new Date(now.getTime() + 2 * 60 * 1000).toISOString();
  }

  // Handle "in X minutes/hours"
  let m = s.match(/^in\s+(\d{1,3})\s*(minute|minutes|min|hour|hours|hr|hrs)$/);
  if (m) {
    const amount = parseInt(m[1], 10);
    const multi = m[2].startsWith("hour") || m[2].startsWith("hr") ? 60 : 1;
    return new Date(now.getTime() + amount * multi * 60 * 1000).toISOString();
  }

  // Basic time parsing - implement more sophisticated parsing as needed
  return null;
}

function ensureFutureISO(iso, minLeadMinutes = 2) {
  const now = Date.now();
  if (!iso) return new Date(now + minLeadMinutes * 60 * 1000).toISOString();
  const t = new Date(iso).getTime();
  if (isNaN(t) || t <= now) return new Date(now + minLeadMinutes * 60 * 1000).toISOString();
  return new Date(t).toISOString();
}

async function safeJson(response) {
  const text = await response.text();
  try { 
    return JSON.parse(text); 
  } catch { 
    return { _raw: text }; 
  }
}