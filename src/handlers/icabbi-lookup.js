import { jsonResponse } from '../lib/utils.js';

export async function handleIcabbiLookup(request, env) {
  try {
    const body = await request.json();
    const { action, phone, checkActiveTrips = false } = body;

    if (!phone) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_PHONE'
      }, 400);
    }

    // Call iCabbi API
    const icabbiUrl = `${env.ICABBI_BASE_URL}/users/search`;
    const response = await fetch(icabbiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': env.ICABBI_APP_KEY,
        'X-Secret': env.ICABBI_SECRET
      },
      body: JSON.stringify({
        phone: phone,
        checkActiveTrips: checkActiveTrips
      })
    });

    const data = await response.json();
    return jsonResponse(data);

  } catch (error) {
    console.error('[icabbi-lookup] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'LOOKUP_FAILED',
      message: error.message
    }, 500);
  }
}