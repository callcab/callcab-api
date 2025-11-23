// /pages/api/icabbi-lookup.js
// Production-ready iCabbi lookup with:
// - Robust phone normalization & user/address lookups
// - Active/Upcoming booking detection via /bookings/upcoming
// - Timezone-safe local fields & human-friendly phrasing
// - CORS + clear error messages

export default async function handler(req, res) {
  const ALLOW_ORIGIN = "*";

  // Basic hardening / headers
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    let {
      action = "lookup",
      phone,
      ix,
      period = 365,
      limit,
      minUses,
      type = "PICKUP",
      debug = false,
      userData = {},
      approved = 1,
      checkActiveTrips = true
    } = body;

    // API configuration
    const BASE = (process.env.ICABBI_BASE_URL || "https://api.icabbi.us/us2").replace(/\/+$/, "");
    const appKey = process.env.ICABBI_APP_KEY;
    const secret = process.env.ICABBI_SECRET || process.env.ICABBI_SECRET_KEY;

    if (!appKey || !secret) {
      return res.status(500).json({
        ok: false,
        error: "MISSING_ICABBI_KEYS",
        message: "Set ICABBI_APP_KEY and ICABBI_SECRET (or ICABBI_SECRET_KEY)."
      });
    }

    const basic = Buffer.from(`${appKey}:${secret}`).toString("base64");
    const BASE_HEADERS = {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Basic ${basic}`,
    };

    switch (action) {
      case "lookup":
        return await handleLookup(req, res, {
          phone, ix, period, limit, minUses, type, debug, checkActiveTrips, BASE, BASE_HEADERS
        });
      case "getAllUsers":
        return await handleGetAllUsers(req, res, { debug, BASE, BASE_HEADERS });
      case "getAccounts":
        return await handleGetAccounts(req, res, { phone, debug, BASE, BASE_HEADERS });
      case "getAddresses":
        return await handleGetAddresses(req, res, { phone, period, type, limit, minUses, approved, debug, BASE, BASE_HEADERS });
      case "create":
        return await handleCreate(req, res, { phone, userData, debug, BASE, BASE_HEADERS });
      case "update":
        return await handleUpdate(req, res, { phone, userData, debug, BASE, BASE_HEADERS });
      default:
        return res.status(400).json({
          ok: false,
          error: "INVALID_ACTION",
          message: `Action '${action}' not supported. Use: lookup, getAllUsers, getAccounts, getAddresses, create, update`
        });
    }
  } catch (err) {
    console.error("[icabbi-lookup] error:", err);
    return res.status(500).json({
      ok: false,
      error: "REQUEST_FAILED",
      message: err?.message || "Unknown error"
    });
  }
}

/* ============================================================================
   Timezone helpers (DST-safe via IANA zone)
   ========================================================================== */
const LOCAL_TZ = process.env.LOCAL_TZ || "America/Denver";

function toLocalISO(iso, tz = LOCAL_TZ) {
  if (!iso) return null;
  const d = new Date(iso); // UTC parse
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function formatLocalText(iso, tz = LOCAL_TZ, now = new Date()) {
  if (!iso) return null;

  // Always format the ORIGINAL instant; don't rebuild a UTC date from local parts
  const src = new Date(iso);

  // Use toLocalISO for the relative day check
  const nowLocalStr = toLocalISO(now.toISOString(), tz).slice(0, 10);
  const targetLocalStr = toLocalISO(iso, tz).slice(0, 10);

  let rel = null;
  if (targetLocalStr === nowLocalStr) {
    rel = "today";
  } else {
    const n = new Date(nowLocalStr + "T00:00:00");
    const t = new Date(targetLocalStr + "T00:00:00");
    const diffDays = Math.round((t - n) / 86400000);
    if (diffDays === 1) rel = "tomorrow";
  }

  // Format human-friendly labels directly from the original instant
  const fmtDate = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric"
  });
  const fmtTime = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit"
  });

  const dateLabel = fmtDate.format(src);
  const timeLabel = fmtTime.format(src);

  return rel ? `${rel} at ${timeLabel} (${dateLabel})` : `${dateLabel} at ${timeLabel}`;
}

/* ============================================================================
   LOOKUP HANDLER - User + addresses + active/upcoming trips
   ========================================================================== */
async function handleLookup(req, res, { phone, ix, period, limit, minUses, type, debug, checkActiveTrips, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, req.body);
  if (!phone || String(phone).trim().length < 7) {
    return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Provide a phone number with at least seven digits." });
  }

  const norm = normalizeDigits(phone);
  const e164 = `+1${norm}`;
  const idd = `001${norm}`;
  const raw = String(phone).trim();
  const formats = Array.from(new Set([idd, e164, norm, raw])).filter(v => v && v.length >= 7);

  // 1) Find user by phone (header -> query fallbacks)
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
      activeTrips: [], hasActiveTrips: false,
      ...(debug ? { upstream, base: BASE, sentAuth: "basic", phoneIn: phone } : {})
    });
  }

  if (user.banned) {
    return res.status(200).json({
      ok: true, found: true,
      user: { id: user.id, name: user.name || null, phone: user.phone || null, banned: true },
      activeTrips: [], hasActiveTrips: false,
      message: "Banned user - contact office"
    });
  }

  // 2) Address history
  const params = new URLSearchParams({ period: String(period) });
  if (type) params.set("type", String(type).toUpperCase());
  if (limit) params.set("limit", String(limit));

  const phoneForHistory = user.phone || idd;
  let aRes = await fetch(`${BASE}/users/addresses?phone=${encodeURIComponent(phoneForHistory)}&${params.toString()}`, {
    method: "GET", headers: BASE_HEADERS
  });
  let aJson = await safeJson(aRes);

  if (!Array.isArray(aJson?.body?.addresses) || aJson.body.addresses.length === 0) {
    // try header variant
    aRes = await fetch(`${BASE}/users/addresses?${params.toString()}`, { method: "GET", headers: { ...BASE_HEADERS, Phone: phoneForHistory } });
    aJson = await safeJson(aRes);
  }

  let addresses = Array.isArray(aJson?.body?.addresses) ? aJson.body.addresses : [];
  if (Number.isFinite(minUses) && minUses > 0) {
    addresses = addresses.filter(a => (a.used ?? 0) >= minUses);
  }

  const slim = addresses.map(a => ({
    id: a.id, formatted: a.formatted || null, used: a.used ?? 0,
    lat: a.lat ?? null, lng: a.lng ?? null, postcode: a.postcode ?? null
  })).filter(x => x.formatted);

  const primaryAddress = pickPrimary(slim);

  const account = user.account ? {
    id: user.account.id,
    name: user.account.name,
    type: user.account.type,
    active: user.account.active === 1 || user.account.active === "1",
    notes: user.account.notes || null,
    driver_notes: user.account.driver_notes || null
  } : null;

  // 3) Active/Upcoming bookings via /bookings/upcoming (phone must be 00-prefixed)
  let activeTrips = [];
  let hasActiveTrips = false;

  if (checkActiveTrips) {
    try {
      const phoneForUpcoming =
        phoneForHistory.startsWith('+') ? '00' + phoneForHistory.slice(1) :
        phoneForHistory.startsWith('001') ? phoneForHistory :
        '001' + norm;

      const bookingRes = await fetch(`${BASE}/bookings/upcoming?phone=${encodeURIComponent(phoneForUpcoming)}`, {
        method: "GET", headers: BASE_HEADERS
      });
      const bookingJson = await safeJson(bookingRes);

      if (bookingJson?.body?.bookings && Array.isArray(bookingJson.body.bookings) && bookingJson.body.bookings.length > 0) {
        const now = new Date();
        const activeStatuses = ['NEW', 'ASSIGNED', 'ACCEPTED', 'PICKED_UP', 'DISPATCHED', 'PENDING', 'PREBOOKED'];

        activeTrips = bookingJson.body.bookings
          .filter(booking => {
            const isActiveStatus = activeStatuses.includes(String(booking.status || "").toUpperCase());
            const pickupDate = booking.pickup_date ? new Date(booking.pickup_date) : null;
            const isRecentOrFuture = pickupDate && (pickupDate.getTime() > now.getTime() - 30 * 60 * 1000);
            return isActiveStatus && isRecentOrFuture;
          })
          .map(booking => {
            const pickup_local_iso = toLocalISO(booking.pickup_date, LOCAL_TZ);
            const pickup_epoch_ms = booking.pickup_date ? new Date(booking.pickup_date).getTime() : null;
            const pickup_local_text = formatLocalText(booking.pickup_date, LOCAL_TZ);
            return {
              trip_id: booking.trip_id,
              perma_id: booking.perma_id,
              status: booking.status,
              status_text: booking.status_text || booking.status,
              pickup_date: booking.pickup_date,  // UTC ISO
              pickup_local_iso,                  // Local wall time (no offset)
              pickup_local_text,                 // Human-friendly label
              pickup_epoch_ms,
              eta: booking.eta || null,
              pickup_address: booking.address?.formatted || null,
              pickup_lat: booking.address?.lat || null,
              pickup_lng: booking.address?.lng || null,
              destination_address: booking.destination?.formatted || null,
              destination_lat: booking.destination?.lat || null,
              destination_lng: booking.destination?.lng || null,
              driver: booking.driver ? {
                id: booking.driver.id,
                name: booking.driver.name,
                vehicle: booking.driver.vehicle?.ref || null,
                phone: booking.driver.phone || null
              } : null,
              instructions: booking.instructions || null,
              vehicle_type: booking.vehicle_type || null,
              account_id: booking.account_id || null
            };
          })
          .sort((a, b) => (a.pickup_epoch_ms || 0) - (b.pickup_epoch_ms || 0));

        if (activeTrips.length > 0) hasActiveTrips = true;
      }
    } catch (error) {
      console.error("[icabbi-lookup] Active trips check failed:", error);
      // Non-fatal; continue without active trips
    }
  }

  return res.status(200).json({
    ok: true,
    found: true,
    user: {
      id: user.id,
      ix: user.ix,
      phone: user.phone,
      name: user.name || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      email: user.email || null,
      vip: !!user.vip,
      banned: false,
      score: user.score ?? null,
      trusted: !!user.trusted,
      payment_type: user.payment_type || null,
      has_creditcards: !!(user.has_creditcards || (user.creditcards && Object.keys(user.creditcards || {}).length > 0)),
      account_id: user.account_id || null,
      account_type: user.account_type || null,
      account_notes: user.account_notes || null,
      account
    },
    primaryAddress,
    addresses: orderByUsed(slim),
    count: slim.length,
    periodDays: Number(period),
    type: String(type).toUpperCase(),
    activeTrips,
    hasActiveTrips,
    nextTrip: activeTrips.length > 0 ? activeTrips[0] : null,
    summary: makeSummary({ user, primaryAddress, addresses: slim, activeTrips, hasActiveTrips }),
    ...(debug ? { attempt: lastAttempt, base: BASE, sentAuth: "basic", phoneIn: phone } : {})
  });
}

/* ============================================================================
   Other handlers
   ========================================================================== */
async function handleGetAllUsers(req, res, { debug, BASE, BASE_HEADERS }) {
  try {
    const r = await fetch(`${BASE}/users`, { method: "POST", headers: BASE_HEADERS });
    const j = await safeJson(r);
    const arr = Array.isArray(j?.body?.users) ? j.body.users : [];
    const users = arr.map(u => ({
      id: u.id, ix: u.ix, phone: u.phone,
      name: u.name || null, first_name: u.first_name || null, last_name: u.last_name || null,
      email: u.email || null, vip: !!u.vip, banned: !!u.banned, score: u.score ?? null,
      trusted: !!u.trusted, account_id: u.account_id || null, account_type: u.account_type || null
    }));
    return res.status(200).json({ ok: true, found: users.length > 0, users, count: users.length, ...(debug ? { base: BASE } : {}) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: "GET_ALL_USERS_FAILED", message: error?.message || "Failed to retrieve users" });
  }
}

async function handleGetAccounts(req, res, { phone, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, req.body);
  if (!phone || String(phone).trim().length < 7) {
    return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });
  }
  const norm = normalizeDigits(phone);
  const e164 = `+1${norm}`;
  const idd = `001${norm}`;
  const formats = [idd, e164, norm];

  let accountData = null;
  for (const p of formats) {
    try {
      const r = await fetch(`${BASE}/users/accounts?phone=${encodeURIComponent(p)}`, {
        method: "GET", headers: { ...BASE_HEADERS, Phone: p }
      });
      const j = await safeJson(r);
      if (j?.body?.accounts) { accountData = j.body.accounts; break; }
    } catch {
      // try next format
    }
  }

  if (!accountData) {
    return res.status(200).json({ ok: true, found: false, accounts: [], message: "No accounts found for this phone number" });
  }
  return res.status(200).json({ ok: true, found: true, accounts: Array.isArray(accountData) ? accountData : [accountData], ...(debug ? { phone } : {}) });
}

async function handleGetAddresses(req, res, { phone, period = 365, type = "PICKUP", limit, minUses, approved = 1, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, req.body);
  if (!phone || String(phone).trim().length < 7) {
    return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });
  }

  const norm = normalizeDigits(phone);
  const e164 = `+1${norm}`;
  const idd = `001${norm}`;
  const formats = [idd, e164, norm];

  const params = new URLSearchParams({ period: String(period) });
  if (type) params.set("type", String(type).toUpperCase());
  if (limit) params.set("limit", String(limit));
  if (approved !== undefined) params.set("approved", String(approved));

  let addresses = [];
  for (const phoneFormat of formats) {
    try {
      const r = await fetch(`${BASE}/users/addresses?phone=${encodeURIComponent(phoneFormat)}&${params.toString()}`, {
        method: "GET", headers: { ...BASE_HEADERS, Phone: phoneFormat }
      });
      const j = await safeJson(r);
      if (Array.isArray(j?.body?.addresses)) { addresses = j.body.addresses; break; }
    } catch {
      // try next
    }
  }

  if (!addresses.length) {
    return res.status(200).json({ ok: true, found: false, addresses: [], message: "No addresses found" });
  }

  if (Number.isFinite(minUses) && minUses > 0) {
    addresses = addresses.filter(a => (a.used ?? 0) >= minUses);
  }

  return res.status(200).json({
    ok: true, found: true,
    addresses: addresses.map(a => ({
      id: a.id, formatted: a.formatted || null, used: a.used ?? 0,
      lat: a.lat ?? null, lng: a.lng ?? null, postcode: a.postcode ?? null,
      phonetic: a.phonetic || null, zone_id: a.zone_id || null
    })),
    count: addresses.length, type: String(type).toUpperCase(), periodDays: period || 21,
    ...(debug ? { phone } : {})
  });
}

async function handleCreate(req, res, { phone, userData, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, req.body);
  if (!phone || String(phone).trim().length < 7) {
    return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });
  }
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
      const u = Array.isArray(j.body.user) ? j.body.user[0] : j.body.user;
      return res.status(200).json({
        ok: true, created: true,
        user: {
          id: u.id, ix: u.ix, phone: u.phone, name: u.name,
          first_name: u.first_name, last_name: u.last_name, email: u.email,
          vip: !!u.vip, banned: !!u.banned, score: u.score
        },
        message: "User created successfully",
        ...(debug ? { request: createBody } : {})
      });
    }
    return res.status(502).json({ ok: false, error: "CREATE_FAILED", message: j?.message || "Could not create user", ...(debug ? { response: j } : {}) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "CREATE_ERROR", message: err?.message || "Error creating user" });
  }
}

async function handleUpdate(req, res, { phone, userData, debug, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone, req.body);
  if (!phone || String(phone).trim().length < 7) {
    return res.status(400).json({ ok: false, error: "MISSING_PHONE", hint: "Phone number required" });
  }
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
      const u = Array.isArray(j.body.user) ? j.body.user[0] : j.body.user;
      return res.status(200).json({
        ok: true, updated: true,
        user: {
          id: u.id, ix: u.ix, phone: u.phone, name: u.name,
          first_name: u.first_name, last_name: u.last_name, email: u.email,
          vip: !!u.vip, banned: !!u.banned, score: u.score
        },
        message: "User updated successfully",
        ...(debug ? { request: updateBody } : {})
      });
    }
    return res.status(502).json({ ok: false, error: "UPDATE_FAILED", message: j?.message || "Could not update user", ...(debug ? { response: j } : {}) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "UPDATE_ERROR", message: err?.message || "Error updating user" });
  }
}

/* ============================================================================
   Utilities
   ========================================================================== */
function coercePhone(primary, body) {
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
  function scan(o) {
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
  }
  scan(body);

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

function normalizeDigits(p) {
  return String(p).replace(/[^\d]/g, "").replace(/^1?(\d{10})$/, "$1");
}

async function safeJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { _raw: t }; }
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
    const when = trip.pickup_local_text || formatLocalText(trip.pickup_date);
    const from = trip.pickup_address || "your pickup";
    const to = trip.destination_address || "your destination";
    const top = primaryAddress ? ` Your usual pickup is ${primaryAddress}.` : "";
    return `Hi ${n}. You have an active trip (${trip.trip_id}) ${when} from ${from} to ${to}.${top}`.trim();
  }

  const top = primaryAddress ? `Top pickup is ${primaryAddress}.` : "No recent pickups found.";
  const more = addresses.length > 1 ? ` I also have ${addresses.slice(1, 6).map(a => a.formatted).join("; ")}.` : "";
  return `Hi ${n}. ${top}${more}`.trim();
}
