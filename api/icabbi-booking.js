// /pages/api/icabbi-booking.js
// PRODUCTION – Vapi-ready iCabbi booking endpoint
// Actions: create | get | cancel | update | status_update | upcoming | upcoming_slim | active
//
// Env (Vercel):
//   ICABBI_BASE_URL=https://api.icabbi.us/us2
//   ICABBI_APP_KEY=xxxxxxxx
//   ICABBI_SECRET=yyyyyyyy

const SERVICE_TZ = "America/Denver";
const DEFAULT_CALLER_NAME = "";
const DEFAULT_CALLER_PHONE = "";

export default async function handler(req, res) {
  const ALLOW_ORIGIN = "*";

  // CORS
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.status(200).end();
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);

  if (!["POST", "GET"].includes(req.method)) {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  const log = (level, message, data = {}) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, message, ...data }));

  try {
    // Parse JSON and unwrap { properties: {...} } if present
    const rawBody =
      req.method === "POST"
        ? typeof req.body === "string"
          ? JSON.parse(req.body || "{}")
          : (req.body || {})
        : {};
    const body =
      rawBody && typeof rawBody === "object" && rawBody.properties
        ? rawBody.properties
        : rawBody;

    // Inputs
    const {
      action = req.method === "GET" ? "get" : "create",
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

    // Credentials
    const BASE = (process.env.ICABBI_BASE_URL || "https://api.icabbi.us/us2").replace(/\/+$/, "");
    const APP = process.env.ICABBI_APP_KEY;
    const SEC = process.env.ICABBI_SECRET || process.env.ICABBI_SECRET_KEY;
    if (!APP || !SEC) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_ICABBI_KEYS",
        message: "Set ICABBI_BASE_URL, ICABBI_APP_KEY, ICABBI_SECRET env vars.",
      });
    }
    const AUTH = Buffer.from(`${APP}:${SEC}`).toString("base64");
    const BASE_HEADERS = {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Basic ${AUTH}`,
    };

    // Shared phone resolution with Mallory default
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
        req,
        res,
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

    if (action === "get" || (req.method === "GET" && action !== "cancel")) {
      const id = req.query.trip_id || trip_id;
      const inc = (req.query.include_segments ?? include_segments) ? true : false;
      return await handleGet({ res, BASE, BASE_HEADERS, log, trip_id: id, include_segments: inc, debug });
    }

    if (action === "cancel") {
      const id = body?.trip_id || req.query?.trip_id || trip_id;
      return await handleCancel({ res, BASE, BASE_HEADERS, log, trip_id: id, debug });
    }

    if (action === "update") {
      const id = body?.trip_id || req.query?.trip_id || trip_id;
      return await handleUpdate({
        res,
        BASE,
        BASE_HEADERS,
        log,
        trip_id: id,
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
        res,
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
        res,
        BASE,
        BASE_HEADERS,
        log,
        endpoint: "bookings/upcoming",
        // default Mallory phone filter so results are scoped to her
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
        res,
        BASE,
        BASE_HEADERS,
        log,
        endpoint: "bookings/upcoming_slim",
        query: {
          limit, page, order_by, order_dir,
          from, to,
          site_id,
          // slim doesn't take phone in all builds, but include if accepted by your tenant
          phone: toIcabbiPhone(resolvedPhoneE164),
        },
        debug,
      });
    }

    if (action === "active") {
      return await handleList({
        res,
        BASE,
        BASE_HEADERS,
        log,
        endpoint: "bookings/active",
        query: {
          limit, page, order_by, order_dir, payment_method,
          account_only, vehicle_ref, include_segments, accounts,
          // optional phone filter if your tenant supports it on active
          phone: toIcabbiPhone(resolvedPhoneE164),
        },
        debug,
      });
    }

    return res.status(400).json({ ok: false, error: "INVALID_ACTION", message: `Action '${action}' not supported.` });
  } catch (err) {
    console.error("[icabbi] Fatal:", err);
    return res.status(500).json({ ok: false, error: "REQUEST_FAILED", message: err?.message || "Unexpected error" });
  }
}

// ---------------- CREATE ----------------
async function handleCreate(params) {
  const {
    req,
    res,
    debug,
    BASE,
    BASE_HEADERS,
    log,
    rawPhone,
    name,
    pickup,
    destination,
    date,
    instructions,
    source,
    site_id,
  } = params;

  // Resolve caller ID from headers if body missed it
  const headerPhone =
    req.headers["x-vapi-caller-number"] ||
    req.headers["x-caller-number"] ||
    req.headers["x-callerid-number"] ||
    req.headers["x-from-number"] ||
    req.headers["x-ani"] ||
    req.headers["from"] ||
    req.headers["x-user-phone"] ||
    req.headers["x-phone"];

  const phoneE164 = normalizePhone(rawPhone || headerPhone || DEFAULT_CALLER_PHONE);

  if (!phoneE164) {
    return res.status(400).json({
      ok: false,
      error: "MISSING_PHONE",
      message: "Phone required",
      ask_user_for_phone: true,
    });
  }

  // Validate pickup/destination basics
  if (!pickup?.lat || !pickup?.lng) {
    return res.status(400).json({ ok: false, error: "MISSING_PICKUP", message: "Pickup lat/lng required" });
  }
  if (destination?.lat && !destination?.lng) {
    return res.status(400).json({ ok: false, error: "MISSING_DESTINATION_LNG", message: "Destination lng required" });
  }

  // Zone validation (strict)
  const zone = await validateZone(pickup.lat, pickup.lng, BASE, BASE_HEADERS, log);
  if (!zone.valid) {
    let msg = "Cannot create booking: ";
    if (zone.reason === "NO_ZONES") msg += "Location not in service area.";
    else if (zone.reason === "NO_ACTIVE_ZONES") msg += "No active zones in service area.";
    else if (zone.reason === "ZONES_FULLY_BOOKED") msg += `All drivers busy${zone.until ? ` until ${zone.until}` : ""}.`;
    else msg += "Service unavailable in this area.";
    return res.status(400).json({
      ok: false,
      error: "ZONE_VALIDATION_FAILED",
      message: msg,
      details: debug ? { zone } : undefined,
    });
  }

  // Parse & ensure future
  const parsedISO = parseWhenToISO(date);
  const pickupISO = ensureFutureISO(parsedISO, 2);
  const minutesOut = Math.round((new Date(pickupISO).getTime() - Date.now()) / 60000);
  const isFuture = minutesOut >= 5;

  if (debug) {
    log("info", "Create booking timezone debug", {
      input: date,
      parsedISO,
      pickupISO,
      minutesOut,
      isFuture
    });
  }

  const payload = {
    source: source || "DISPATCH",
    site_id,
    phone: phoneE164,
    name: name || DEFAULT_CALLER_NAME,

    date: pickupISO,
    pickup_date: pickupISO,
    prebooked: isFuture ? 1 : 0,

    address: {
      lat: parseFloat(pickup.lat),
      lng: parseFloat(pickup.lng),
      formatted: pickup.address || `${pickup.lat}, ${pickup.lng}`,
    },

    vehicle_type: "R4",
    vehicle_group: "Taxi",
    attributegroup_id: 1,

    zone_id: parseInt(zone.primary.id, 10),

    instructions: instructions || "Claire booking",

    idempotency_key: `icb-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };

  if (destination?.lat && destination?.lng) {
    payload.destination = {
      lat: parseFloat(destination.lat),
      lng: parseFloat(destination.lng),
      formatted: destination.address || `${destination.lat}, ${destination.lng}`,
    };
  }

  try {
    const r = await fetch(`${BASE}/bookings/add`, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify(payload),
    });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0");

    if (!success) {
      if (String(data.code) === "602") {
        return res.status(409).json({
          ok: false,
          error: "ZONES_FULLY_BOOKED",
          message: data.message || "All drivers busy. Please try again shortly.",
          icabbiResponse: debug ? data : undefined,
          requestSent: debug ? payload : undefined,
        });
      }
      return res.status(400).json({
        ok: false,
        error: "BOOKING_CREATE_FAILED",
        message: data.message || "Booking creation failed",
        icabbiResponse: debug ? data : undefined,
        requestSent: debug ? payload : undefined,
      });
    }

    const b = data.body?.booking;
    if (!b) {
      return res.status(500).json({
        ok: false,
        error: "NO_BOOKING_RETURNED",
        message: "No booking object in response",
        icabbiResponse: debug ? data : undefined,
      });
    }

    return res.status(200).json({
      ok: true,
      created: true,
      booking: {
        trip_id: b.trip_id,
        perma_id: b.perma_id,
        status: b.status,
        status_text: b.status_text,
        pickup_date: b.pickup_date,
        eta: b.eta,
        address: b.address?.formatted,
        destination: b.destination?.formatted,
        site_id: b.site_id,
        zone_id: b.zone_id,
        vehicle_type: b.vehicle_type,
        driver: b.driver ? { id: b.driver.id, name: b.driver.name, vehicle: b.driver.vehicle?.ref } : null,
      },
      message: `Booking created: ${b.trip_id}`,
      debug: debug ? { full_response: data, request: payload, zone } : undefined,
    });
  } catch (err) {
    log("error", "Create exception", { error: err.message });
    return res.status(500).json({ ok: false, error: "CREATE_ERROR", message: err?.message || "Unexpected error" });
  }
}

// ---------------- GET ----------------
async function handleGet({ res, BASE, BASE_HEADERS, log, trip_id, include_segments = false, debug }) {
  if (!trip_id) return res.status(400).json({ ok: false, error: "MISSING_TRIP_ID" });

  try {
    const url = `${BASE}/bookings/index/${encodeURIComponent(trip_id)}${include_segments ? "?all_segments=1" : ""}`;
    const r = await fetch(url, { method: "GET", headers: BASE_HEADERS });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0");
    if (!success) {
      return res.status(404).json({ ok: false, error: "BOOKING_NOT_FOUND", message: data.message || "Failed to get booking" });
    }
    const b = data.body?.booking;
    return res.status(200).json({
      ok: true,
      found: true,
      booking: {
        trip_id: b.trip_id,
        status: b.status,
        status_text: b.status_text,
        name: b.name,
        phone: b.phone,
        address: b.address?.formatted,
        destination: b.destination?.formatted,
        driver: b.driver ? { name: b.driver.name, vehicle: b.driver.vehicle?.ref } : null,
      },
      debug: debug ? { full_response: data } : undefined,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "GET_ERROR", message: err?.message });
  }
}

// ---------------- CANCEL ----------------
async function handleCancel({ res, BASE, BASE_HEADERS, log, trip_id, debug }) {
  if (!trip_id) return res.status(400).json({ ok: false, error: "MISSING_TRIP_ID" });

  try {
    const r = await fetch(`${BASE}/bookings/cancel/${encodeURIComponent(trip_id)}`, {
      method: "POST",
      headers: BASE_HEADERS,
    });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0");
    if (!success) {
      return res.status(400).json({ ok: false, error: "CANCEL_FAILED", message: data.message || "Failed to cancel" });
    }
    return res.status(200).json({ ok: true, cancelled: true, trip_id, message: `Booking ${trip_id} cancelled` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "CANCEL_ERROR", message: err?.message });
  }
}

// ---------------- UPDATE ----------------
async function handleUpdate(params) {
  const {
    res,
    BASE,
    BASE_HEADERS,
    log,
    trip_id,
    phone,
    name,
    date,
    pickup,
    destination,
    instructions,
    route_by,
    site_id,
    debug,
  } = params;

  if (!trip_id) {
    return res.status(400).json({ ok: false, error: "MISSING_TRIP_ID", message: "trip_id is required for update" });
  }

  const payload = {};
  if (phone) payload.phone = normalizePhone(phone);
  if (name) payload.name = name;

  if (typeof route_by === "string" && /^(appt|default)$/.test(route_by)) payload.route_by = route_by;
  if (site_id != null) payload.site_id = site_id;

  // Date handling - ONLY update if explicitly provided with actual value
  // Check for truthy string value to handle all edge cases
  if (date && typeof date === "string" && date.trim().length > 0 && 
      date.toLowerCase() !== "undefined" && date.toLowerCase() !== "null") {
    const parsedISO = parseWhenToISO(date);
    const iso = ensureFutureISO(parsedISO, 2);
    payload.date = iso;
    payload.appointment_date = iso;
    payload.planned_date = iso;
    
    if (debug) {
      log("info", "Update: Including date change", { 
        original: date, 
        parsed: iso 
      });
    }
  }
  // If date is not provided or empty, field is omitted = time stays unchanged

  // Pickup address (prebookings)
  if (pickup?.lat && pickup?.lng) {
    payload.address = {
      lat: parseFloat(pickup.lat),
      lng: parseFloat(pickup.lng),
      formatted: pickup.address || `${pickup.lat}, ${pickup.lng}`,
    };
  }

  // Destination
  if (destination?.lat && destination?.lng) {
    payload.destination = {
      lat: parseFloat(destination.lat),
      lng: parseFloat(destination.lng),
      formatted: destination.address || `${destination.lat}, ${destination.lng}`,
    };
  }

  if (instructions) payload.instructions = instructions;

  payload.idempotency_key = `icb-up-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const r = await fetch(`${BASE}/bookings/update/${encodeURIComponent(trip_id)}`, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify(payload),
    });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0" || data.code === 200);

    if (!success) {
      return res.status(400).json({
        ok: false,
        error: "BOOKING_UPDATE_FAILED",
        message: data.message || "Update failed",
        icabbiResponse: debug ? data : undefined,
        requestSent: debug ? payload : undefined,
      });
    }

    const booking = data.body?.booking || {};
    return res.status(200).json({
      ok: true,
      updated: true,
      booking: booking,
      message: `Booking updated successfully`,
      debug: debug ? { full_response: data, request: payload } : undefined,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "UPDATE_ERROR", message: err?.message || "Unexpected error" });
  }
}

// ---------------- STATUS UPDATE ----------------
async function handleStatusUpdate({ res, BASE, BASE_HEADERS, log, perma_id, status, debug }) {
  if (!perma_id) return res.status(400).json({ ok: false, error: "MISSING_PERMA_ID", message: "perma_id is required" });
  if (!status) return res.status(400).json({ ok: false, error: "MISSING_STATUS", message: "status is required" });

  const payload = {
    perma_id,
    status, // e.g., "NOSHOW", "CANCELLED" (must be valid for your fleet)
    idempotency_key: `icb-status-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  };

  try {
    const r = await fetch(`${BASE}/bookings/status_update`, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify(payload),
    });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0" || data.code === 200);

    if (!success) {
      return res.status(400).json({
        ok: false,
        error: "STATUS_UPDATE_FAILED",
        message: data.message || "Status update failed",
        icabbiResponse: debug ? data : undefined,
        requestSent: debug ? payload : undefined,
      });
    }

    return res.status(200).json({
      ok: true,
      status_updated: true,
      perma_id,
      status,
      message: `Booking ${perma_id} status updated to ${status}`,
      debug: debug ? { full_response: data, request: payload } : undefined,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "STATUS_UPDATE_ERROR", message: err?.message || "Unexpected error" });
  }
}

// ---------------- LIST HELPERS ----------------
async function handleList({ res, BASE, BASE_HEADERS, log, endpoint, query = {}, debug }) {
  // Build query string (drop undefined/empty)
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const url = `${BASE}/${endpoint}${qs.toString() ? `?${qs.toString()}` : ""}`;

  try {
    const r = await fetch(url, { method: "GET", headers: BASE_HEADERS });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0" || data.code === 200);
    if (!success) {
      return res.status(400).json({
        ok: false,
        error: "LIST_FAILED",
        message: data.message || `Failed to fetch ${endpoint}`,
        icabbiResponse: debug ? data : undefined,
        requested_url: debug ? url : undefined,
      });
    }
    return res.status(200).json({
      ok: true,
      endpoint,
      total: data.body?.total ?? undefined,
      total_available: data.body?.total_available ?? undefined,
      bookings: data.body?.bookings ?? [],
      debug: debug ? { url, full_response: data } : undefined,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "LIST_ERROR", message: err?.message || "Unexpected error" });
  }
}

// ---------------- UTILITIES ----------------
async function validateZone(lat, lng, BASE, BASE_HEADERS, log) {
  try {
    const r = await fetch(`${BASE}/zone/index?lat=${lat}&lng=${lng}`, { method: "GET", headers: BASE_HEADERS });
    const d = await safeJson(r);
    const success = r.ok && (d.code === 0 || d.code === "0");
    if (!success || !Array.isArray(d.body?.zones) || d.body.zones.length === 0) {
      return { valid: false, reason: "NO_ZONES" };
    }
    const active = d.body.zones.filter((z) => z.active === "1" || z.active === 1);
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

// Convert +E.164 to iCabbi expected "international" form for list filters (e.g. +1XXXXXXXXXX -> 001XXXXXXXXXX)
function toIcabbiPhone(e164) {
  if (!e164) return undefined;
  const digits = e164.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) return "001" + digits.slice(1);
  // generic: +CC... -> 00CC...
  if (e164.startsWith("+")) return "00" + e164.slice(1);
  return digits;
}

// ---------- Timezone helpers (no external deps) ----------
function _offsetMinutesFor(tz, instant = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUTCms = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUTCms - instant.getTime()) / 60000);
}

function zonedISO(tz, y, m, d, h = 0, mi = 0, s = 0) {
  const pretend = new Date(Date.UTC(y, m - 1, d, h, mi, s));
  const offMin = _offsetMinutesFor(tz, pretend);
  const utcMs = pretend.getTime() - offMin * 60000;
  return new Date(utcMs).toISOString();
}

// Parse friendly/ISO-ish/epoch into UTC ISO, assuming SERVICE_TZ wall-clock when no TZ provided
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

  // Check if "tomorrow" is mentioned anywhere (for both "tomorrow at 5" and "5 tomorrow")
  const hasTomorrow = /\btomorrow\b/.test(s);
  
  // Strip modifiers for time extraction
  const sClean = s
    .replace(/\btonight\b/g, '')
    .replace(/\btomorrow\b/g, '')
    .replace(/\bthis evening\b/g, '')
    .replace(/\bthis morning\b/g, '')
    .replace(/\bthis afternoon\b/g, '')
    .replace(/\btoday\b/g, '')
    .replace(/\bat\b/g, '')
    .trim();

  // Extract time from cleaned string
  m = sClean.match(/^(\d{1,2})\s*:?\s*(\d{2})?\s*(am|pm)?$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] || null;
    
    // Handle AM/PM
    if (ap) {
      if (ap === "pm" && hh < 12) hh += 12;
      if (ap === "am" && hh === 12) hh = 0;
    } else if (hh >= 5 && hh <= 11) {
      // Auto-detect PM for dinner/evening hours (5-11) when no AM/PM specified
      const nowMT = new Date().toLocaleString("en-US", { timeZone: SERVICE_TZ, hour: "numeric", hour12: false });
      const currentHour = parseInt(nowMT);
      if (currentHour >= 12 || currentHour < 5) {
        hh += 12;
      }
    }
    
    // Get current date in Mountain Time
    const fmt = new Intl.DateTimeFormat("en-US", { 
      timeZone: SERVICE_TZ, 
      year: "numeric", 
      month: "2-digit", 
      day: "2-digit"
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    let y = +parts.year, mon = +parts.month, d = +parts.day;
    
    // If "tomorrow" was mentioned, add one day
    if (hasTomorrow) {
      const tomorrow = new Date(Date.UTC(y, mon - 1, d, 0, 0, 0));
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowParts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { 
          timeZone: SERVICE_TZ, 
          year: "numeric", 
          month: "2-digit", 
          day: "2-digit" 
        }).formatToParts(tomorrow).map((p) => [p.type, p.value])
      );
      y = +tomorrowParts.year;
      mon = +tomorrowParts.month;
      d = +tomorrowParts.day;
      
      return zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
    }
    
    // No "tomorrow" - create for today
    let iso = zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
    
    // If that time has already passed today, assume they mean tomorrow
    if (new Date(iso).getTime() <= Date.now()) {
      const tomorrow = new Date(Date.UTC(y, mon - 1, d, 0, 0, 0));
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const tomorrowParts = Object.fromEntries(
        new Intl.DateTimeFormat("en-US", { 
          timeZone: SERVICE_TZ, 
          year: "numeric", 
          month: "2-digit", 
          day: "2-digit" 
        }).formatToParts(tomorrow).map((p) => [p.type, p.value])
      );
      y = +tomorrowParts.year;
      mon = +tomorrowParts.month;
      d = +tomorrowParts.day;
      iso = zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
    }
    
    return iso;
  }

  // Handle ISO-like: "YYYY-MM-DD HH:MM"
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})$/i);
  if (m) {
    const y = +m[1], mon = +m[2], d = +m[3], hh = +m[4], mm = +m[5];
    return zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
  }

  // Last resort: try native Date parsing
  const sloppy = new Date(text);
  if (!isNaN(sloppy.getTime())) {
    if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return sloppy.toISOString();
    const onlyDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (onlyDate) return zonedISO(SERVICE_TZ, +onlyDate[1], +onlyDate[2], +onlyDate[3], 0, 0, 0);
    return sloppy.toISOString();
  }

  return null;
}

function ensureFutureISO(iso, minLeadMinutes = 2) {
  const now = Date.now();
  if (!iso) return new Date(now + minLeadMinutes * 60 * 1000).toISOString();
  const t = new Date(iso).getTime();
  if (isNaN(t) || t <= now) return new Date(now + minLeadMinutes * 60 * 1000).toISOString();
  return new Date(t).toISOString();
}

async function safeJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _raw: t }; }
}
