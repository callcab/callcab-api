// pages/api/food-quote.js
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const BASE = process.env.TOOL_BASE || 'https://aspen-address-validator.vercel.app';

export default async function handler(req, res) {
  const ALLOW_ORIGIN='*';
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'METHOD_NOT_ALLOWED' });

  try {
    const {
      restaurant_name,
      location = 'Aspen Colorado',
      prep_time_minutes = 25,
      dropoff
    } = req.body || {};

    if (!restaurant_name) return res.status(400).json({ ok:false, error:'MISSING_RESTAURANT_NAME' });
    if (!dropoff?.lat || !dropoff?.lng || !dropoff?.address)
      return res.status(400).json({ ok:false, error:'MISSING_DROPOFF' });

    // 1) Get restaurant coords/name via your validator
    const vResp = await fetch(`${BASE}/api/google-validate-address`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({
        query: `${restaurant_name} ${location}`,
        regionBias: { lat:39.1911, lng:-106.8175, radiusMeters:120000 },
        allowOutsideServiceArea: true
      })
    });
    const place = await vResp.json();
    if (!vResp.ok || !place?.lat || !place?.lng) {
      return res.status(502).json({ ok:false, error:'RESTAURANT_LOOKUP_FAILED', detail: place });
    }

    const pickup = {
      lat: place.lat,
      lng: place.lng,
      address: place.address || `${restaurant_name}, ${location}`,
      name: place.name || restaurant_name
    };

    // 2) Route quote (restaurant → dropoff)
    const rqResp = await fetch(`${BASE}/api/route-quote`, {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ pickup, dropoff })
    });
    const q = await rqResp.json();
    if (!rqResp.ok) return res.status(502).json({ ok:false, error:'ROUTE_QUOTE_FAILED', detail:q });

    // 3) Combine with kitchen prep time
    const driveMin = q?.duration_minutes ?? null;
    const low = driveMin ? Math.max(10, Math.round(prep_time_minutes + driveMin)) : null;
    const high = low ? Math.round(low * 1.3) : null;
    const combined_eta_summary = (low && high) ? `${low} to ${high} minutes` : 'about an hour';

    return res.status(200).json({
      ok: true,
      pickup,
      distance_text: q?.distance_text,
      duration_text: q?.duration_text,
      distance_miles: q?.distance_miles,
      duration_minutes: driveMin,
      fare_estimate_low: q?.fare_estimate_low,
      fare_estimate_high: q?.fare_estimate_high,
      fare_estimate_mid: q?.fare_estimate_mid,
      has_airport_fee: !!q?.has_airport_fee,
      combined_eta_summary,
      combined_eta_minutes_low: low,
      combined_eta_minutes_high: high
    });
  } catch (e) {
    console.error('[food-quote] error', e);
    return res.status(500).json({ ok:false, error:'FOOD_QUOTE_FAILED', message:e?.message || 'Unknown error' });
  }
}