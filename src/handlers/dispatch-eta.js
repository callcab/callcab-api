import { jsonResponse } from '../lib/utils.js';

export async function handleDispatchETA(request, env) {
  try {
    const body = await request.json();
    const { pickup_lat, pickup_lng, pickup_address } = body;

    if (!pickup_lat || !pickup_lng) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_COORDINATES'
      }, 400);
    }

    // Simulate ETA calculation
    // In production, this would call your dispatch system
    const eta_minutes = Math.floor(Math.random() * 10) + 5; // 5-15 minutes
    const arrival_time = new Date(Date.now() + eta_minutes * 60000);

    return jsonResponse({
      ok: true,
      eta_minutes,
      eta_summary: `${eta_minutes} minutes`,
      arrival_time: arrival_time.toISOString(),
      arrival_time_formatted: arrival_time.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        timeZone: 'America/Denver'
      })
    });

  } catch (error) {
    console.error('[dispatch-eta] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'ETA_CALCULATION_FAILED',
      message: error.message
    }, 500);
  }
}