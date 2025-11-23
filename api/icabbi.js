// /pages/api/icabbi.js
// PRODUCTION – Unified iCabbi endpoint with FIXED date parsing
// Actions: create, get, cancel, update, status_update, upcoming, active, lookup, user ops

const SERVICE_TZ = "America/Denver";
const DEFAULT_CALLER_NAME = "Mallory";
const DEFAULT_CALLER_PHONE = "+13109635871";

export default async function handler(req, res) {
  const ALLOW_ORIGIN = "*";

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

    const {
      action = req.method === "GET" ? "get" : "create",
      debug = false,
      phone,
      customer,
      callerPhone,
      caller_number,
      ix,
      period = 365,
      limit,
      minUses,
      type = "PICKUP",
      userData = {},
      approved = 1,
      checkActiveTrips = true,
      name,
      pickup,
      destination,
      date,
      instructions,
      trip_id,
      perma_id,
      status,
      source = "DISPATCH",
      site_id,
      route_by,
      include_segments,
      page,
      order_by,
      order_dir,
      from,
      to,
      payment_method,
      vehicle_ref,
      account_only,
      accounts,
      account_id,
      user_id,
    } = body;

    const BASE = (process.env.ICABBI_BASE_URL || "https://api.icabbi.us/us2").replace(/\/+$/, "");
    const APP = process.env.ICABBI_APP_KEY;
    const SEC = process.env.ICABBI_SECRET || process.env.ICABBI_SECRET_KEY;
    if (!APP || !SEC) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_ICABBI_KEYS",
        message: "Set ICABBI_BASE_URL, ICABBI_APP_KEY, ICABBI_SECRET env vars."
      });
    }
    const AUTH = Buffer.from(`${APP}:${SEC}`).toString("base64");
    const BASE_HEADERS = {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Basic ${AUTH}`,
    };

    const resolvedPhoneE164 =
      normalizePhone(
        phone ||
          customer?.phone ||
          customer?.number ||
          callerPhone ||
          caller_number ||
          body?.rawPhoneDigits ||
          headerPhone(req) ||
          DEFAULT_CALLER_PHONE
      ) || DEFAULT_CALLER_PHONE;

    switch (action) {
      case "create":
      case "add":
        return await handleCreate({
          req, res, debug, BASE, BASE_HEADERS, log,
          rawPhone: resolvedPhoneE164,
          name: name || customer?.name || DEFAULT_CALLER_NAME,
          pickup, destination, date, instructions, source,
          site_id: site_id ?? 74,
        });

      case "get": {
        const id = req.query.trip_id || trip_id;
        const inc = (req.query.include_segments ?? include_segments) ? true : false;
        return await handleGet({ res, BASE, BASE_HEADERS, log, trip_id: id, include_segments: inc, debug });
      }

      case "cancel": {
        const id = body?.trip_id || req.query?.trip_id || trip_id;
        return await handleCancel({ res, BASE, BASE_HEADERS, log, trip_id: id, debug });
      }

      case "update": {
        const id = body?.trip_id || req.query?.trip_id || trip_id;
        return await handleUpdate({
          res, BASE, BASE_HEADERS, log, trip_id: id,
          phone: resolvedPhoneE164,
          name: name || customer?.name || DEFAULT_CALLER_NAME,
          date, pickup, destination, instructions, route_by, site_id, debug
        });
      }

      case "status_update":
        return await handleStatusUpdate({
          res, BASE, BASE_HEADERS, log, perma_id: perma_id || body?.perma_id, status, debug
        });

      case "upcoming":
        return await handleList({
          res, BASE, BASE_HEADERS, log, endpoint: "bookings/upcoming",
          query: {
            limit, page, order_by, order_dir, from, to, payment_method,
            vehicle_ref, account_only, include_segments, site_id, account_id,
            accounts, user_id,
            phone: toIcabbiPhone(resolvedPhoneE164),
          },
          debug,
        });

      case "upcoming_slim":
        return await handleList({
          res, BASE, BASE_HEADERS, log, endpoint: "bookings/upcoming_slim",
          query: { limit, page, order_by, order_dir, from, to, site_id, phone: toIcabbiPhone(resolvedPhoneE164) },
          debug,
        });

      case "active":
        return await handleList({
          res, BASE, BASE_HEADERS, log, endpoint: "bookings/active",
          query: {
            limit, page, order_by, order_dir, payment_method,
            account_only, vehicle_ref, include_segments, accounts,
            phone: toIcabbiPhone(resolvedPhoneE164),
          },
          debug,
        });

      case "lookup":
        return await handleLookup({
          req, res, phone: phone ?? resolvedPhoneE164, ix, period, limit, minUses, type, debug,
          checkActiveTrips, BASE, BASE_HEADERS
        });

      case "getAllUsers":
        return await handleGetAllUsers({ res, debug, BASE, BASE_HEADERS });

      case "getAccounts":
        return await handleGetAccounts({ res, phone: phone ?? resolvedPhoneE164, debug, BASE, BASE_HEADERS });

      case "getAddresses":
        return await handleGetAddresses({
          res, phone: phone ?? resolvedPhoneE164, period, type, limit, minUses, approved, debug, BASE, BASE_HEADERS
        });

      case "create_user":
        return await handleCreateUser({ res, phone: phone ?? resolvedPhoneE164, userData, debug, BASE, BASE_HEADERS });

      case "update_user":
        return await handleUpdateUser({ res, phone: phone ?? resolvedPhoneE164, userData, debug, BASE, BASE_HEADERS });

      default:
        return res.status(400).json({
          ok: false,
          error: "INVALID_ACTION",
          message: `Action '${action}' not supported.`
        });
    }
  } catch (err) {
    console.error("[icabbi] Fatal:", err);
    return res.status(500).json({ ok: false, error: "REQUEST_FAILED", message: err?.message || "Unexpected error" });
  }
}

// ============================================================================
// BOOKING HANDLERS
// ============================================================================
async function handleCreate({ req, res, debug, BASE, BASE_HEADERS, log, rawPhone, name, pickup, destination, date, instructions, source, site_id }) {
  const phoneE164 = normalizePhone(rawPhone || headerPhone(req) || DEFAULT_CALLER_PHONE);
  if (!phoneE164) return res.status(400).json({ ok: false, error: "MISSING_PHONE", message: "Phone required", ask_user_for_phone: true });

  if (!pickup?.lat || !pickup?.lng) return res.status(400).json({ ok: false, error: "MISSING_PICKUP", message: "Pickup lat/lng required" });
  if (destination?.lat && !destination?.lng) return res.status(400).json({ ok: false, error: "MISSING_DESTINATION_LNG", message: "Destination lng required" });

  const zone = await validateZone(pickup.lat, pickup.lng, BASE, BASE_HEADERS, log);
  if (!zone.valid) {
    let msg = "Cannot create booking: ";
    if (zone.reason === "NO_ZONES") msg += "Location not in service area.";
    else if (zone.reason === "NO_ACTIVE_ZONES") msg += "No active zones in service area.";
    else if (zone.reason === "ZONES_FULLY_BOOKED") msg += `All drivers busy${zone.until ? ` until ${zone.until}` : ""}.`;
    else msg += "Service unavailable in this area.";
    return res.status(400).json({ ok: false, error: "ZONE_VALIDATION_FAILED", message: msg, details: debug ? { zone } : undefined });
  }

  const parsedISO = parseWhenToISO(date);
  const pickupISO = ensureFutureISO(parsedISO, 2);
  const minutesOut = Math.round((new Date(pickupISO).getTime() - Date.now()) / 60000);
  const isFuture = minutesOut >= 5;

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
    const r = await fetch(`${BASE}/bookings/add`, { method: "POST", headers: BASE_HEADERS, body: JSON.stringify(payload) });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0");

    if (!success) {
      if (String(data.code) === "602") {
        return res.status(409).json({ ok: false, error: "ZONES_FULLY_BOOKED", message: data.message || "All drivers busy. Please try again shortly.", icabbiResponse: debug ? data : undefined, requestSent: debug ? payload : undefined });
      }
      return res.status(400).json({ ok: false, error: "BOOKING_CREATE_FAILED", message: data.message || "Booking creation failed", icabbiResponse: debug ? data : undefined, requestSent: debug ? payload : undefined });
    }

    const b = data.body?.booking;
    if (!b) return res.status(500).json({ ok: false, error: "NO_BOOKING_RETURNED", message: "No booking object in response", icabbiResponse: debug ? data : undefined });

    return res.status(200).json({
      ok: true,
      created: true,
      booking: {
        trip_id: b.trip_id,
        perma_id: b.perma_id,
        status: b.status,
        status_text: b.status_text,
        pickup_date: b.pickup_date,
        prebooked: payload.prebooked,
        eta: b.eta,
        address: b.address?.formatted,
        destination: b.destination?.formatted,
        site_id: b.site_id,
        zone_id: b.zone_id,
        vehicle_type: b.vehicle_type,
        driver: b.driver ? { id: b.driver.id, name: b.driver.name, vehicle: b.driver.vehicle?.ref } : null,
      },
      message: `Booking created: ${b.trip_id}`,
      debug: debug ? { full_response: data, request: payload, zone, parsed_date: pickupISO, minutes_out: minutesOut } : undefined,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "CREATE_ERROR", message: err?.message || "Unexpected error" });
  }
}

async function handleGet({ res, BASE, BASE_HEADERS, log, trip_id, include_segments = false, debug }) {
  if (!trip_id) return res.status(400).json({ ok: false, error: "MISSING_TRIP_ID" });
  try {
    const url = `${BASE}/bookings/index/${encodeURIComponent(trip_id)}${include_segments ? "?all_segments=1" : ""}`;
    const r = await fetch(url, { method: "GET", headers: BASE_HEADERS });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0");
    if (!success) return res.status(404).json({ ok: false, error: "BOOKING_NOT_FOUND", message: data.message || "Failed to get booking" });
    const b = data.body?.booking;
    return res.status(200).json({
      ok: true, found: true,
      booking: {
        trip_id: b.trip_id,
        status: b.status,
        status_text: b.status_text,
        name: b.name,
        phone: b.phone,
        pickup_date: b.pickup_date,
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

async function handleCancel({ res, BASE, BASE_HEADERS, log, trip_id, debug }) {
  if (!trip_id) return res.status(400).json({ ok: false, error: "MISSING_TRIP_ID" });
  try {
    const r = await fetch(`${BASE}/bookings/cancel/${encodeURIComponent(trip_id)}`, { method: "POST", headers: BASE_HEADERS });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0");
    if (!success) return res.status(400).json({ ok: false, error: "CANCEL_FAILED", message: data.message || "Failed to cancel" });
    return res.status(200).json({ ok: true, cancelled: true, trip_id, message: `Booking ${trip_id} cancelled` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "CANCEL_ERROR", message: err?.message });
  }
}

async function handleUpdate({ res, BASE, BASE_HEADERS, log, trip_id, phone, name, date, pickup, destination, instructions, route_by, site_id, debug }) {
  if (!trip_id) return res.status(400).json({ ok: false, error: "MISSING_TRIP_ID", message: "trip_id is required for update" });

  const payload = {};
  if (phone) payload.phone = normalizePhone(phone);
  if (name) payload.name = name;
  if (typeof route_by === "string" && /^(appt|default)$/.test(route_by)) payload.route_by = route_by;
  if (site_id != null) payload.site_id = site_id;

  if (date != null) {
    const parsedISO = parseWhenToISO(date);
    const iso = ensureFutureISO(parsedISO, 2);
    payload.date = iso;
    payload.appointment_date = iso;
    payload.planned_date = iso;
  }
  if (pickup?.lat && pickup?.lng) {
    payload.address = { lat: +pickup.lat, lng: +pickup.lng, formatted: pickup.address || `${pickup.lat}, ${pickup.lng}` };
  }
  if (destination?.lat && destination?.lng) {
    payload.destination = { lat: +destination.lat, lng: +destination.lng, formatted: destination.address || `${destination.lat}, ${destination.lng}` };
  }
  if (instructions) payload.instructions = instructions;
  payload.idempotency_key = `icb-up-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const r = await fetch(`${BASE}/bookings/update/${encodeURIComponent(trip_id)}`, { method: "POST", headers: BASE_HEADERS, body: JSON.stringify(payload) });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0" || data.code === 200);
    if (!success) return res.status(400).json({ ok: false, error: "BOOKING_UPDATE_FAILED", message: data.message || "Update failed", icabbiResponse: debug ? data : undefined, requestSent: debug ? payload : undefined });
    return res.status(200).json({ ok: true, updated: true, booking: data.body?.booking || null, message: `Booking ${trip_id} updated`, debug: debug ? { full_response: data, request: payload } : undefined });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "UPDATE_ERROR", message: err?.message || "Unexpected error" });
  }
}

async function handleStatusUpdate({ res, BASE, BASE_HEADERS, log, perma_id, status, debug }) {
  if (!perma_id) return res.status(400).json({ ok: false, error: "MISSING_PERMA_ID", message: "perma_id is required" });
  if (!status) return res.status(400).json({ ok: false, error: "MISSING_STATUS", message: "status is required" });

  const payload = { perma_id, status, idempotency_key: `icb-status-${Date.now()}-${Math.random().toString(16).slice(2)}` };

  try {
    const r = await fetch(`${BASE}/bookings/status_update`, { method: "POST", headers: BASE_HEADERS, body: JSON.stringify(payload) });
    const data = await safeJson(r);
    const success = r.ok && (data.code === 0 || data.code === "0" || data.code === 200);
    if (!success) return res.status(400).json({ ok: false, error: "STATUS_UPDATE_FAILED", message: data.message || "Status update failed", icabbiResponse: debug ? data : undefined, requestSent: debug ? payload : undefined });
    return res.status(200).json({ ok: true, status_updated: true, perma_id, status, message: `Booking ${perma_id} status updated to ${status}`, debug: debug ? { full_response: data, request: payload } : undefined });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "STATUS_UPDATE_ERROR", message: err?.message || "Unexpected error" });
  }
}

async function handleList({ res, BASE, BASE_HEADERS, log, endpoint, query = {}, debug }) {
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
    if (!success) return res.status(400).json({ ok: false, error: "LIST_FAILED", message: data.message || `Failed to fetch ${endpoint}`, icabbiResponse: debug ? data : undefined, requested_url: debug ? url : undefined });
    return res.status(200).json({ ok: true, endpoint, total: data.body?.total ?? undefined, total_available: data.body?.total_available ?? undefined, bookings: data.body?.bookings ?? [], debug: debug ? { url, full_response: data } : undefined });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "LIST_ERROR", message: err?.message || "Unexpected error" });
  }
}

// ============================================================================
// LOOKUP & USER HANDLERS
// ============================================================================
async function handleLookup({ req, res, phone, ix, period, limit, minUses, type, debug, checkActiveTrips, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, req.body);
  if (!phone || String(phone).trim().length < 7) return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Please provide a phone number with at least seven digits." });

  const norm = normalizeDigits(phone);
  const e164 = `+1${norm}`;
  const idd = `001${norm}`;
  const raw = String(phone).trim();
  const formats = Array.from(new Set([idd, e164, norm, raw])).filter(v => v && v.length >= 7);

  let user = null, lastAttempt = null, upstream = null;
  for (const p of formats) {
    lastAttempt = { path: "/users/index", where: "header", p };
    const r = await fetch(`${BASE}/users/index`, { method: "POST", headers: { ...BASE_HEADERS, Phone: p } });
    const j = await safeJson(r);
    upstream = { status: r.status, body: j };
    user = j?.body?.user || null;
    if (user) { lastAttempt.success = true; break; }
  }
  if (!user) {
    for (const p of formats) {
      lastAttempt = { path: "/users/index?phone=", where: "query", p };
      const r = await fetch(`${BASE}/users/index?phone=${encodeURIComponent(p)}`, { method: "POST", headers: BASE_HEADERS });
      const j = await safeJson(r);
      upstream = { status: r.status, body: j };
      user = j?.body?.user || null;
      if (user) { lastAttempt.success = true; break; }
    }
  }

  if (!user) {
    return res.status(200).json({
      ok: true, found: false, reason: "NO_USER", phoneTried: formats, attempt: lastAttempt,
      activeTrips: [], hasActiveTrips: false, ...(debug ? { upstream, base: BASE, sentAuth: "basic", phoneIn: phone } : {})
    });
  }

  if (user.banned) {
    return res.status(200).json({ ok: true, found: true, user: { id: user.id, name: user.name || null, phone: user.phone || null, banned: true }, activeTrips: [], hasActiveTrips: false, message: "Banned user - contact office" });
  }

  const params = new URLSearchParams({ period: String(period) });
  if (type) params.set("type", type.toUpperCase());
  if (limit) params.set("limit", String(limit));
  const phoneForHistory = user.phone || idd;

  let aRes = await fetch(`${BASE}/users/addresses?phone=${encodeURIComponent(phoneForHistory)}&${params.toString()}`, { method: "GET", headers: BASE_HEADERS });
  let aJson = await safeJson(aRes);
  if (!Array.isArray(aJson?.body?.addresses) || aJson.body.addresses.length === 0) {
    aRes = await fetch(`${BASE}/users/addresses?${params.toString()}`, { method: "GET", headers: { ...BASE_HEADERS, Phone: phoneForHistory } });
    aJson = await safeJson(aRes);
  }

  let addresses = Array.isArray(aJson?.body?.addresses) ? aJson.body.addresses : [];
  if (Number.isFinite(minUses) && minUses > 0) addresses = addresses.filter(a => (a.used ?? 0) >= minUses);

  const slim = addresses.map(a => ({ id: a.id, formatted: a.formatted || null, used: a.used ?? 0, lat: a.lat ?? null, lng: a.lng ?? null, postcode: a.postcode ?? null })).filter(x => x.formatted);
  const primaryAddress = pickPrimary(slim);

  const account = user.account ? { id: user.account.id, name: user.account.name, type: user.account.type, active: user.account.active === 1 || user.account.active === "1", notes: user.account.notes || null, driver_notes: user.account.driver_notes || null } : null;

  let activeTrips = [];
  let hasActiveTrips = false;
  if (checkActiveTrips) {
    try {
      for (const phoneFormat of [phoneForHistory, e164, idd, norm]) {
        try {
          const bookingRes = await fetch(`${BASE}/bookings/index`, { method: "POST", headers: { ...BASE_HEADERS, Phone: phoneFormat } });
          const bookingJson = await safeJson(bookingRes);
          if (bookingJson?.body?.bookings && Array.isArray(bookingJson.body.bookings) && bookingJson.body.bookings.length > 0) {
            const now = new Date();
            const activeStatuses = ['ASSIGNED','ACCEPTED','PICKED_UP','DISPATCHED','PENDING','PREBOOKED'];
            activeTrips = bookingJson.body.bookings
              .filter(b => {
                const isActive = activeStatuses.includes((b.status || "").toUpperCase());
                const pd = b.pickup_date ? new Date(b.pickup_date) : null;
                const isRecentOrFuture = pd && (pd.getTime() > now.getTime() - 30*60*1000);
                return isActive && isRecentOrFuture;
              })
              .map(b => ({
                trip_id: b.trip_id, perma_id: b.perma_id, status: b.status, status_text: b.status_text || b.status,
                pickup_date: b.pickup_date, eta: b.eta || null,
                pickup_address: b.address?.formatted || null, pickup_lat: b.address?.lat || null, pickup_lng: b.address?.lng || null,
                destination_address: b.destination?.formatted || null, destination_lat: b.destination?.lat || null, destination_lng: b.destination?.lng || null,
                driver: b.driver ? { id: b.driver.id, name: b.driver.name, vehicle: b.driver.vehicle?.ref || null, phone: b.driver.phone || null } : null,
                instructions: b.instructions || null, vehicle_type: b.vehicle_type || null, account_id: b.account_id || null
              }))
              .sort((a,b) => new Date(a.pickup_date) - new Date(b.pickup_date));
            if (activeTrips.length > 0) { hasActiveTrips = true; break; }
          }
        } catch { /* continue */ }
      }
    } catch (e) {
      console.error("[icabbi] Active trips check failed:", e);
    }
  }

  return res.status(200).json({
    ok: true, found: true,
    user: {
      id: user.id, ix: user.ix, phone: user.phone,
      name: user.name || null, first_name: user.first_name || null, last_name: user.last_name || null,
      email: user.email || null, vip: !!user.vip, banned: false, score: user.score ?? null, trusted: !!user.trusted,
      payment_type: user.payment_type || null, has_creditcards: !!user.creditcards || (user.creditcards && Object.keys(user.creditcards).length > 0),
      account_id: user.account_id || null, account_type: user.account_type || null, account_notes: user.account_notes || null, account
    },
    primaryAddress,
    addresses: orderByUsed(slim),
    count: slim.length,
    periodDays: Number(period),
    type: type.toUpperCase(),
    activeTrips, hasActiveTrips, nextTrip: activeTrips.length > 0 ? activeTrips[0] : null,
    summary: makeSummary({ user, primaryAddress, addresses: slim, activeTrips, hasActiveTrips }),
    ...(debug ? { attempt: lastAttempt, base: BASE, sentAuth: "basic", phoneIn: phone } : {})
  });
}

async function handleGetAllUsers({ res, debug, BASE, BASE_HEADERS }) {
  try {
    const r = await fetch(`${BASE}/users`, { method: "POST", headers: BASE_HEADERS });
    const j = await safeJson(r);
    if (!j?.body?.users || !Array.isArray(j.body.users)) return res.status(200).json({ ok: true, found: false, users: [], count: 0, message: "No users found" });
    const users = j.body.users.map(u => ({ id: u.id, ix: u.ix, phone: u.phone, name: u.name || null, first_name: u.first_name || null, last_name: u.last_name || null, email: u.email || null, vip: !!u.vip, banned: !!u.banned, score: u.score ?? null, trusted: !!u.trusted, account_id: u.account_id || null, account_type: u.account_type || null }));
    return res.status(200).json({ ok: true, found: true, users, count: users.length, ...(debug ? { base: BASE } : {}) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "GET_ALL_USERS_FAILED", message: error?.message || "Failed to retrieve users" });
  }
}

async function handleGetAccounts({ res, phone, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, {});
  if (!phone || String(phone).trim().length < 7) return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });
  const norm = normalizeDigits(phone); const e164 = `+1${norm}`; const idd = `001${norm}`; const formats = [idd, e164, norm];
  let accountData = null;
  for (const p of formats) {
    try {
      const r = await fetch(`${BASE}/users/accounts?phone=${encodeURIComponent(p)}`, { method: "GET", headers: { ...BASE_HEADERS, Phone: p } });
      const j = await safeJson(r);
      if (j?.body?.accounts) { accountData = j.body.accounts; break; }
    } catch { /* next */ }
  }
  if (!accountData) return res.status(200).json({ ok: true, found: false, accounts: [], message: "No accounts found for this phone number" });
  return res.status(200).json({ ok: true, found: true, accounts: Array.isArray(accountData) ? accountData : [accountData], ...(debug ? { phone } : {}) });
}

async function handleGetAddresses({ res, phone, period = 365, type = "PICKUP", limit, minUses, approved = 1, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, {});
  if (!phone || String(phone).trim().length < 7) return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });

  const norm = normalizeDigits(phone); const e164 = `+1${norm}`; const idd = `001${norm}`; const formats = [idd, e164, norm];
  const params = new URLSearchParams({ period: String(period) });
  if (type) params.set("type", type.toUpperCase());
  if (limit) params.set("limit", String(limit));
  if (approved !== undefined) params.set("approved", String(approved));

  let addresses = [];
  for (const p of formats) {
    try {
      const r = await fetch(`${BASE}/users/addresses?phone=${encodeURIComponent(p)}&${params.toString()}`, { method: "GET", headers: { ...BASE_HEADERS, Phone: p } });
      const j = await safeJson(r);
      if (j?.body?.addresses && Array.isArray(j.body.addresses)) { addresses = j.body.addresses; break; }
    } catch { /* next */ }
  }
  if (!addresses || addresses.length === 0) return res.status(200).json({ ok: true, found: false, addresses: [], message: "No addresses found" });

  return res.status(200).json({
    ok: true, found: true,
    addresses: addresses.map(a => ({ id: a.id, formatted: a.formatted || null, used: a.used ?? 0, lat: a.lat ?? null, lng: a.lng ?? null, postcode: a.postcode ?? null, phonetic: a.phonetic || null, zone_id: a.zone_id || null })),
    count: addresses.length, type: type ? type.toUpperCase() : "PICKUP", periodDays: period || 21, ...(debug ? { phone } : {})
  });
}

async function handleCreateUser({ res, phone, userData, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, {});
  if (!phone || String(phone).trim().length < 7) return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });

  const norm = normalizeDigits(phone);
  const e164 = `+1${norm}`;
  const createBody = {
    phone: e164,
    first_name: userData.first_name || userData.firstName || "",
    last_name: userData.last_name || userData.lastName || "",
    email: userData.email || "",
    password: userData.password || ""
  };

  try {
    const r = await fetch(`${BASE}/users/create`, { method: "POST", headers: BASE_HEADERS, body: JSON.stringify(createBody) });
    const j = await safeJson(r);
    if (j?.body?.user) {
      const user = Array.isArray(j.body.user) ? j.body.user[0] : j.body.user;
      return res.status(200).json({ ok: true, created: true, user: { id: user.id, ix: user.ix, phone: user.phone, name: user.name, first_name: user.first_name, last_name: user.last_name, email: user.email, vip: !!user.vip, banned: !!user.banned, score: user.score }, message: "User created successfully", ...(debug ? { request: createBody } : {}) });
    }
    return res.status(500).json({ ok: false, error: "CREATE_FAILED", message: j?.message || "Could not create user", ...(debug ? { response: j } : {}) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "CREATE_ERROR", message: err?.message || "Error creating user" });
  }
}

async function handleUpdateUser({ res, phone, userData, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, {});
  if (!phone || String(phone).trim().length < 7) return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });

  const norm = normalizeDigits(phone);
  const e164 = `+1${norm}`;
  const updateBody = {
    phone: e164,
    ...(userData.first_name || userData.firstName ? { first_name: userData.first_name || userData.firstName } : {}),
    ...(userData.last_name || userData.lastName ? { last_name: userData.last_name || userData.lastName } : {}),
    ...(userData.email ? { email: userData.email } : {}),
    ...(userData.password ? { password: userData.password } : {})
  };

  try {
    const r = await fetch(`${BASE}/users/update`, { method: "POST", headers: BASE_HEADERS, body: JSON.stringify(updateBody) });
    const j = await safeJson(r);
    if (j?.body?.user) {
      const user = Array.isArray(j.body.user) ? j.body.user[0] : j.body.user;
      return res.status(200).json({ ok: true, updated: true, user: { id: user.id, ix: user.ix, phone: user.phone, name: user.name, first_name: user.first_name, last_name: user.last_name, email: user.email, vip: !!user.vip, banned: !!user.banned, score: user.score }, message: "User updated successfully", ...(debug ? { request: updateBody } : {}) });
    }
    return res.status(500).json({ ok: false, error: "UPDATE_FAILED", message: j?.message || "Could not update user", ...(debug ? { response: j } : {}) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "UPDATE_ERROR", message: err?.message || "Error updating user" });
  }
}

// ============================================================================
// UTILITIES
// ============================================================================
function headerPhone(req) {
  return (
    req.headers["x-vapi-caller-number"] ||
    req.headers["x-caller-number"] ||
    req.headers["x-callerid-number"] ||
    req.headers["x-from-number"] ||
    req.headers["x-ani"] ||
    req.headers["from"] ||
    req.headers["x-user-phone"] ||
    req.headers["x-phone"] ||
    null
  );
}

async function validateZone(lat, lng, BASE, BASE_HEADERS, log) {
  try {
    const r = await fetch(`${BASE}/zone/index?lat=${lat}&lng=${lng}`, { method: "GET", headers: BASE_HEADERS });
    const d = await safeJson(r);
    const success = r.ok && (d.code === 0 || d.code === "0");
    if (!success || !Array.isArray(d.body?.zones) || d.body.zones.length === 0) return { valid: false, reason: "NO_ZONES" };
    const active = d.body.zones.filter((z) => z.active === "1" || z.active === 1);
    if (!active.length) return { valid: false, reason: "NO_ACTIVE_ZONES" };
    const available = active.filter((z) => !(z.fully_booked_times?.length));
    if (!available.length) return { valid: false, reason: "ZONES_FULLY_BOOKED", until: active[0]?.fully_booked_times?.[0]?.to };
    return { valid: true, primary: available[0] };
  } catch {
    return { valid: false, reason: "VALIDATION_ERROR" };
  }
}

function normalizePhone(input) {
  if (!input) return null;
  let raw = String(input).trim();
  raw = raw.replace(/[^\d+]/g, "");
  if (raw.startsWith("001")) raw = "+1" + raw.slice(3);
  if (/^\+\d{7,15}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits || digits.length < 7) return null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 7 && digits.length <= 15) return `+${digits}`;
  return null;
}

function normalizeDigits(p) {
  return String(p).replace(/[^\d]/g, "").replace(/^1?(\d{10})$/, "$1");
}

function toIcabbiPhone(e164) {
  if (!e164) return undefined;
  const digits = e164.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) return "001" + digits.slice(1);
  if (e164.startsWith("+")) return "00" + e164.slice(1);
  return digits;
}

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

// FIXED DATE PARSING - Handles all "tomorrow" variations
function parseWhenToISO(input) {
  if (input == null) return null;
  const text = String(input).trim();
  if (/^\d{10}$/.test(text)) return new Date(parseInt(text, 10) * 1000).toISOString();
  if (/^\d{13}$/.test(text)) return new Date(parseInt(text, 10)).toISOString();

  const s = text.toLowerCase();
  const now = new Date();

  if (/^(now|right now|asap|immediately|soon)$/.test(s)) return new Date(now.getTime() + 2 * 60 * 1000).toISOString();

  let m = s.match(/^in\s+(\d{1,3})\s*(minute|minutes|min|hour|hours|hr|hrs)$/);
  if (m) {
    const amount = parseInt(m[1], 10);
    const multi = m[2].startsWith("hour") || m[2].startsWith("hr") ? 60 : 1;
    return new Date(now.getTime() + amount * multi * 60 * 1000).toISOString();
  }

  // NEW: Handle "5 PM tomorrow" or "3pm tomorrow" (TIME FIRST)
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+tomorrow$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3];
    if (ap === "pm" && hh < 12) hh += 12;
    if (ap === "am" && hh === 12) hh = 0;
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: SERVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const y = +parts.year, mon = +parts.month, d = +parts.day + 1;
    return zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
  }

  // EXISTING: Handle "tomorrow at 5 PM" or "tomorrow 5pm" (TOMORROW FIRST)
  m = s.match(/^tomorrow(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] || null;
    if (ap) { 
      if (ap === "pm" && hh < 12) hh += 12; 
      if (ap === "am" && hh === 12) hh = 0; 
    }
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: SERVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
    const y = +parts.year, mon = +parts.month, d = +parts.day + 1;
    return zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
  }

  // Just time (today or tomorrow if past)
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let hh = parseInt(m[1], 10);
    const mm = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3] || null;
    if (ap) { 
      if (ap === "pm" && hh < 12) hh += 12; 
      if (ap === "am" && hh === 12) hh = 0; 
    }
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SERVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((p) => [p.type, p.value]));
    let y = +parts.year, mon = +parts.month, d = +parts.day;
    let iso = zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
    if (new Date(iso).getTime() <= Date.now()) {
      const dt = new Date(Date.UTC(y, mon - 1, d, hh, mm, 0));
      dt.setUTCDate(dt.getUTCDate() + 1);
      const parts2 = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: SERVICE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(dt).map((p) => [p.type, p.value]));
      y = +parts2.year; mon = +parts2.month; d = +parts2.day;
      iso = zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
    }
    return iso;
  }

  m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ t](\d{2}):(\d{2})$/i);
  if (m) {
    const y = +m[1], mon = +m[2], d = +m[3], hh = +m[4], mm = +m[5];
    return zonedISO(SERVICE_TZ, y, mon, d, hh, mm, 0);
  }

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

function coercePhone(primary, body = {}) {
  if (primary && String(primary).trim()) return String(primary);
  const aliases = [body.number, body.callback, body.cb, body.digits, body.raw, body.text, body.utterance].filter(Boolean);
  for (const a of aliases) {
    if (Array.isArray(a)) return a.join("");
    if (typeof a === "string") {
      const stripped = a.replace(/[^\d+]/g, "");
      if (stripped.length >= 7) return stripped;
    }
  }
  const candidates = [];
  (function scan(o) {
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (typeof v === "string") {
        const matches = v.match(/\d[\d\-\s\(\)\+]{5,}/g);
        if (matches) candidates.push(...matches);
      } else if (Array.isArray(v)) {
        v.forEach(x => typeof x === "string" && scan({ x }));
      } else if (typeof v === "object") {
        scan(v);
      }
    }
  })(body);
  if (candidates.length) {
    let best = "";
    for (const c of candidates) {
      const digitsOnly = c.replace(/[^\d]/g, "");
      if (digitsOnly.length > best.length) best = digitsOnly;
    }
    if (best.length >= 7) return best;
  }
  return null;
}

function orderByUsed(list) {
  return [...list].sort((a, b) => (b.used || 0) - (a.used || 0));
}

function pickPrimary(list) {
  return list.length ? orderByUsed(list)[0].formatted : null;
}

function makeSummary({ user, primaryAddress, addresses, activeTrips, hasActiveTrips }) {
  const n = user.name || "there";
  if (hasActiveTrips && activeTrips && activeTrips.length > 0) {
    const trip = activeTrips[0];
    const tripInfo = `You have an active trip (${trip.trip_id}) from ${trip.pickup_address || 'your location'} to ${trip.destination_address || 'destination'}.`;
    const top = primaryAddress ? `Your usual pickup is ${primaryAddress}.` : "";
    return `Hi ${n}. ${tripInfo} ${top}`.trim();
  }
  const top = primaryAddress ? `Top pickup is ${primaryAddress}.` : "No recent pickups found.";
  const more = addresses && addresses.length > 1 ? `I also have ${addresses.slice(1, 6).map(a => a.formatted).join("; ")}.` : "";
  return `Hi ${n}. ${top} ${more}`.trim();
}
```

---

# CLAIRE - PRODUCTION DISPATCH PROMPT

## IDENTITY

**Claire** - AI dispatcher for High Mountain Taxi, Aspen CO. Diagnostic mode with full booking capability.

**Voice:** Technical but friendly. Brief explanations. Natural flow.

---

## CALL START (ALWAYS)
```
1. icabbi lookup (phone)
2. weather (Aspen)
3. Greet with context
4. Start flow
```

---

## SMART GREETINGS

**Active ride:**
```
"{{first_name}}! Active ride to {{destination}}, ETA {{eta}} mins, trip {{trip_id}}. 
{{weather_comment}}. Change it or new booking?"
```

**Upcoming:**
```
"{{first_name}}! Booked for {{time}} to {{destination}}, trip {{trip_id}}. 
{{weather}}. Modify or new ride?"
```

**History only:**
```
"{{first_name}}! {{weather}}. Top spots: {{primaryAddress}}, {{addr2}}. 
Send cab where?"
```

**New:**
```
"New caller {{last_4}}. {{weather}}. Name?"
```

---

## BOOKING FLOW

### 1. GET LOCATIONS
```
"Pickup?" 
[validate-address]
"{{address}}, {{lat}}/{{lng}} confirmed."

"Destination?"
[validate-address]  
"{{address}} confirmed."
```

### 2. GET QUOTE
```
[route-quote]
"{{miles}} miles, ${{low}}-{{high}}, {{duration}} mins. Good?"
```

### 3. GET TIMING
```
"When?"

User: "5 PM tomorrow"
"Parsing '5 PM tomorrow'..."

[icabbi create]

Check response:
- prebooked=1? "Booked for tomorrow 5 PM, trip {{trip_id}}."
- prebooked=0? "Date error, retrying different format..."
  [cancel trip]
  [try "tomorrow at 5pm"]
```

### 4. CONFIRM & SUMMARIZE
```
"Booked: {{pickup}} to {{destination}}, {{formatted_time}}.
Trip {{trip_id}}, {{status}}, driver dispatches {{time}}.
{{weather_summary}}. You're set!"
```

---

## MODIFY EXISTING
```
"Trip {{trip_id}}: {{current_details}}. What to change?"

User: "Change to airport"
"Updating destination..."
[validate-address: airport]
[icabbi update]
"Updated, driver notified. New destination: {{airport}}."
```

---

## TOOL USAGE EXAMPLES

**icabbi lookup:**
```
"Looking up {{phone}}..."
Result: "{{name}}, primary {{addr}}, active: {{bool}}"
```

**validate-address:**
```
"Validating {{input}}..."
Result: "{{normalized}}, {{lat}}/{{lng}}"
```

**route-quote:**
```
"Quoting..."
Result: "{{mi}}mi, ${{range}}, {{min}}min"
```

**weather:**
```
"Checking conditions..."
Result: "{{temp}}°F, {{condition}}, {{daypart}}"
```

**web_search:**
```
"Searching {{query}}..."
Result: "Found {{result}}"
```

**icabbi create:**
```
"Booking..."
Result: "Trip {{id}}, prebooked={{flag}}, status={{status}}"
```

---

## DATE HANDLING (AUTO-RETRY)
```
Try formats in order:
1. User input: "5 PM tomorrow"
2. Alt format: "tomorrow at 5pm"
3. Reversed: "5pm tomorrow"

Check prebooked flag:
- 1 = Future ✓
- 0 = Now (wrong for future booking)

If wrong, cancel and retry next format.
Report which worked.
