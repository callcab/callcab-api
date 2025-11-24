import { jsonResponse } from '../lib/utils.js';

export async function handleIcabbiLookup(request, env) {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const { 
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

    if (!phone) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_PHONE',
        hint: 'Provide a phone number with at least seven digits.'
      }, 400);
    }

    // API configuration - EXACTLY like working Vercel version
    const BASE = (env.ICABBI_BASE_URL || "https://api.icabbi.us/us2").replace(/\/+$/, "");
    const appKey = env.ICABBI_APP_KEY;
    const secret = env.ICABBI_SECRET || env.ICABBI_SECRET_KEY;

    if (!appKey || !secret) {
      console.error('[icabbi-lookup] Missing credentials:', {
        hasAppKey: !!appKey,
        hasSecret: !!secret,
        envKeys: Object.keys(env).filter(k => k.includes('ICABBI'))
      });
      
      return jsonResponse({
        ok: false,
        error: "MISSING_ICABBI_KEYS",
        message: "Set ICABBI_APP_KEY and ICABBI_SECRET (or ICABBI_SECRET_KEY)."
      }, 500);
    }

    // Use Basic Auth like the working Vercel version
    const basic = btoa(`${appKey}:${secret}`);
    const BASE_HEADERS = {
      accept: "application/json",
      "content-type": "application/json",
      Authorization: `Basic ${basic}`,
    };

    console.log('[icabbi-lookup] Using Basic Auth for:', BASE);

    // Route to handlers based on action
    switch (action) {
      case "lookup":
        return await handleLookup({
          phone, ix, period, limit, minUses, type, debug, checkActiveTrips, BASE, BASE_HEADERS
        });
      case "getAllUsers":
        return await handleGetAllUsers({ debug, BASE, BASE_HEADERS });
      case "getAccounts":
        return await handleGetAccounts({ phone, debug, BASE, BASE_HEADERS });
      case "getAddresses":
        return await handleGetAddresses({ phone, period, type, limit, minUses, approved, debug, BASE, BASE_HEADERS });
      case "create":
        return await handleCreate({ phone, userData, debug, BASE, BASE_HEADERS });
      case "update":
        return await handleUpdate({ phone, userData, debug, BASE, BASE_HEADERS });
      default:
        return jsonResponse({
          ok: false,
          error: "INVALID_ACTION",
          message: `Action '${action}' not supported. Use: lookup, getAllUsers, getAccounts, getAddresses, create, update`
        }, 400);
    }

  } catch (error) {
    console.error('[icabbi-lookup] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'LOOKUP_FAILED',
      message: error.message
    }, 500);
  }
}

// LOOKUP HANDLER - Exactly replicating working Vercel logic
async function handleLookup({ phone, ix, period, limit, minUses, type, debug, checkActiveTrips, BASE, BASE_HEADERS }) {
  phone = coercePhone(phone);
  if (!phone || String(phone).trim().length < 7) {
    return jsonResponse({ 
      ok: false, 
      error: "MISSING_PHONE", 
      hint: "Provide a phone number with at least seven digits." 
    }, 400);
  }

  const norm = normalizeDigits(phone);
  const e164 = `+1${norm}`;
  const idd = `001${norm}`;
  const raw = String(phone).trim();
  const formats = Array.from(new Set([idd, e164, norm, raw])).filter(v => v && v.length >= 7);

  console.log('[icabbi-lookup] Trying phone formats:', formats);

  // 1) Find user by phone (header -> query fallbacks) - EXACT Vercel logic
  let user = null, lastAttempt = null, upstream = null;

  for (const p of formats) {
    lastAttempt = { path: "/users/index", where: "header", p };
    const r = await fetch(`${BASE}/users/index`, { 
      method: "POST", 
      headers: { ...BASE_HEADERS, Phone: p } 
    });
    const j = await safeJson(r);
    upstream = { status: r.status, body: j };
    user = j?.body?.user || null;
    if (user) { 
      lastAttempt.success = true; 
      console.log('[icabbi-lookup] Found user with header method:', p);
      break; 
    }
  }

  if (!user) {
    for (const p of formats) {
      lastAttempt = { path: "/users/index?phone=", where: "query", p };
      const r = await fetch(`${BASE}/users/index?phone=${encodeURIComponent(p)}`, { 
        method: "POST", 
        headers: BASE_HEADERS 
      });
      const j = await safeJson(r);
      upstream = { status: r.status, body: j };
      user = j?.body?.user || null;
      if (user) { 
        lastAttempt.success = true; 
        console.log('[icabbi-lookup] Found user with query method:', p);
        break; 
      }
    }
  }

  if (!user) {
    return jsonResponse({
      ok: true, 
      found: false, 
      reason: "NO_USER", 
      phoneTried: formats, 
      attempt: lastAttempt,
      activeTrips: [], 
      hasActiveTrips: false,
      ...(debug ? { upstream, base: BASE, sentAuth: "basic", phoneIn: phone } : {})
    });
  }

  if (user.banned) {
    return jsonResponse({
      ok: true, 
      found: true,
      user: { id: user.id, name: user.name || null, phone: user.phone || null, banned: true },
      activeTrips: [], 
      hasActiveTrips: false,
      message: "Banned user - contact office"
    });
  }

  console.log('[icabbi-lookup] Found user:', user.id, user.name || 'unnamed');

  // 2) Address history - EXACT Vercel logic
  const params = new URLSearchParams({ period: String(period) });
  if (type) params.set("type", String(type).toUpperCase());
  if (limit) params.set("limit", String(limit));

  const phoneForHistory = user.phone || idd;
  let aRes = await fetch(`${BASE}/users/addresses?phone=${encodeURIComponent(phoneForHistory)}&${params.toString()}`, {
    method: "GET", 
    headers: BASE_HEADERS
  });
  let aJson = await safeJson(aRes);

  if (!Array.isArray(aJson?.body?.addresses) || aJson.body.addresses.length === 0) {
    // try header variant
    aRes = await fetch(`${BASE}/users/addresses?${params.toString()}`, {
      method: "GET", 
      headers: { ...BASE_HEADERS, Phone: phoneForHistory }
    });
    aJson = await safeJson(aRes);
  }

  const addresses = Array.isArray(aJson?.body?.addresses) ? aJson.body.addresses : [];
  
  // Apply minUses filter if specified
  let filteredAddresses = addresses;
  if (Number.isFinite(minUses) && minUses > 0) {
    filteredAddresses = addresses.filter(a => (a.used ?? 0) >= minUses);
  }

  // 3) Active/upcoming trips if requested
  let activeTrips = [];
  let hasActiveTrips = false;
  let upcomingTrips = [];

  if (checkActiveTrips) {
    try {
      const tripRes = await fetch(`${BASE}/bookings/upcoming?phone=${encodeURIComponent(idd)}`, {
        method: "GET", 
        headers: BASE_HEADERS
      });
      const tripJson = await safeJson(tripRes);
      
      if (Array.isArray(tripJson?.body?.bookings)) {
        const now = Date.now();
        const allTrips = tripJson.body.bookings;
        
        activeTrips = allTrips.filter(trip => {
          const pickupTime = new Date(trip.pickup_date).getTime();
          return pickupTime > now && pickupTime < (now + 24 * 60 * 60 * 1000); // next 24 hours
        });
        
        upcomingTrips = allTrips.filter(trip => {
          const pickupTime = new Date(trip.pickup_date).getTime();
          return pickupTime > (now + 24 * 60 * 60 * 1000); // beyond 24 hours
        });
        
        hasActiveTrips = activeTrips.length > 0;
      }
    } catch (tripError) {
      console.warn('[icabbi-lookup] Trip lookup failed:', tripError.message);
    }
  }

  // 4) Build response exactly like Vercel version
  const response = {
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
      banned: !!user.banned,
      score: user.score || null
    },
    addresses: filteredAddresses.map(a => ({
      id: a.id,
      formatted: a.formatted || null,
      used: a.used ?? 0,
      lat: a.lat ?? null,
      lng: a.lng ?? null,
      postcode: a.postcode ?? null,
      phonetic: a.phonetic || null,
      zone_id: a.zone_id || null
    })),
    primaryAddress: pickPrimary(filteredAddresses),
    activeTrips: activeTrips.map(formatTrip),
    upcomingTrips: upcomingTrips.map(formatTrip),
    hasActiveTrips,
    summary: makeSummary({ 
      user, 
      primaryAddress: pickPrimary(filteredAddresses), 
      addresses: filteredAddresses, 
      activeTrips: activeTrips.map(formatTrip), 
      hasActiveTrips 
    }),
    ...(debug ? { 
      phoneTried: formats, 
      attempt: lastAttempt, 
      upstream, 
      base: BASE 
    } : {})
  };

  return jsonResponse(response);
}

// Helper functions - replicated from working Vercel version
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
  return null;
}

function normalizeDigits(p) {
  return String(p).replace(/[^\d]/g, "").replace(/^1?(\d{10})$/, "$1");
}

async function safeJson(r) {
  const t = await r.text();
  try { 
    return JSON.parse(t); 
  } catch { 
    return { _raw: t }; 
  }
}

function orderByUsed(list) {
  return [...list].sort((a, b) => (b.used || 0) - (a.used || 0));
}

function pickPrimary(list) {
  return list.length ? orderByUsed(list)[0].formatted : null;
}

function formatTrip(trip) {
  return {
    trip_id: trip.trip_id,
    perma_id: trip.perma_id,
    pickup_date: trip.pickup_date,
    pickup_address: trip.pickup_address,
    destination_address: trip.destination_address,
    status: trip.status,
    instructions: trip.instructions || null
  };
}

function makeSummary({ user, primaryAddress, addresses, activeTrips, hasActiveTrips }) {
  const n = user.name || "there";

  if (hasActiveTrips && activeTrips && activeTrips.length > 0) {
    const trip = activeTrips[0];
    const from = trip.pickup_address || "your pickup";
    const to = trip.destination_address || "your destination";
    const top = primaryAddress ? ` Your usual pickup is ${primaryAddress}.` : "";
    return `Hi ${n}. You have an active trip (${trip.trip_id}) from ${from} to ${to}.${top}`.trim();
  }

  const top = primaryAddress ? `Top pickup is ${primaryAddress}.` : "No recent pickups found.";
  const more = addresses.length > 1 ? ` I also have ${addresses.slice(1, 6).map(a => a.formatted).join("; ")}.` : "";
  return `Hi ${n}. ${top}${more}`.trim();
}

// Placeholder handlers for other actions
async function handleGetAllUsers({ debug, BASE, BASE_HEADERS }) {
  return jsonResponse({ ok: false, error: "NOT_IMPLEMENTED", message: "getAllUsers not implemented" }, 501);
}

async function handleGetAccounts({ phone, debug, BASE, BASE_HEADERS }) {
  return jsonResponse({ ok: false, error: "NOT_IMPLEMENTED", message: "getAccounts not implemented" }, 501);
}

async function handleGetAddresses({ phone, period, type, limit, minUses, approved, debug, BASE, BASE_HEADERS }) {
  return jsonResponse({ ok: false, error: "NOT_IMPLEMENTED", message: "getAddresses not implemented" }, 501);
}

async function handleCreate({ phone, userData, debug, BASE, BASE_HEADERS }) {
  return jsonResponse({ ok: false, error: "NOT_IMPLEMENTED", message: "create not implemented" }, 501);
}

async function handleUpdate({ phone, userData, debug, BASE, BASE_HEADERS }) {
  return jsonResponse({ ok: false, error: "NOT_IMPLEMENTED", message: "update not implemented" }, 501);
}