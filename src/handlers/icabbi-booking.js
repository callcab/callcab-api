import { jsonResponse } from '../lib/utils.js';

export async function handleIcabbiBooking(request, env) {
  try {
    const body = await request.json();
    const { action, ...params } = body;

    if (!action) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_ACTION'
      }, 400);
    }

    // Call iCabbi API
    const icabbiUrl = `${env.ICABBI_BASE_URL}/bookings`;
    const response = await fetch(icabbiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': env.ICABBI_APP_KEY,
        'X-Secret': env.ICABBI_SECRET
      },
      body: JSON.stringify({
        action,
        ...params,
        site_id: 74 // High Mountain Taxi site ID
      })
    });

    const data = await response.json();
    return jsonResponse(data);

  } catch (error) {
    console.error('[icabbi-booking] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'BOOKING_FAILED',
      message: error.message
    }, 500);
  }
}