// /pages/api/dispatch.js
// Calculate driver arrival time from High Mountain Taxi base to pickup
// - Uses Google Distance Matrix with traffic
// - Formats arrival time in America/Denver (DST-aware)
// - Returns friendly eta_summary buckets

export default async function handler(req, res) {
  // --- CORS (useful for Vapi dashboard tests) ---
  const ALLOW_ORIGIN = "*";
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return res.status(200).end();
  }
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "METHOD_NOT_ALLOWED" });
  }

  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({ ok: false, error: "NO_GOOGLE_MAPS_API_KEY" });
    }

    // High Mountain Taxi base (AABC)
    const HM_BASE = {
      lat: 39.2228,
      lng: -106.8692,
      address: "214 Aspen Airport Business Ctr, Unit B, Aspen, CO 81611",
    };

    // --- Parse body & coerce types ---
    const { pickup_lat, pickup_lng, pickup_address } = req.body || {};

    const pLat =
      typeof pickup_lat === "string" ? parseFloat(pickup_lat) : pickup_lat;
    const pLng =
      typeof pickup_lng === "string" ? parseFloat(pickup_lng) : pickup_lng;

    if (
      pLat === undefined ||
      pLng === undefined ||
      Number.isNaN(pLat) ||
      Number.isNaN(pLng)
    ) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_COORDS",
        details: "pickup_lat and pickup_lng required",
      });
    }

    if (Math.abs(pLat) > 90 || Math.abs(pLng) > 180) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_COORDS",
        details: "Coordinates are out of valid range",
      });
    }

    // --- Google Distance Matrix (traffic-aware) ---
    const params = new URLSearchParams({
      origins: `${HM_BASE.lat},${HM_BASE.lng}`,
      destinations: `${pLat},${pLng}`,
      units: "imperial",
      mode: "driving",
      region: "US",
      departure_time: "now",
      traffic_model: "best_guess",
      key,
    });

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const gRes = await fetch(url);
    const data = await gRes.json();

    if (data?.status !== "OK" || !data?.rows?.[0]?.elements?.[0]) {
      return res.status(502).json({
        ok: false,
        error: "GOOGLE_API_ERROR",
        google_status: data?.status || "NO_STATUS",
        details: "Failed to retrieve route data from Google Maps",
      });
    }

    const element = data.rows[0].elements[0];
    if (element?.status !== "OK") {
      return res.status(200).json({
        ok: false,
        error: "ROUTE_NOT_FOUND",
        element_status: element?.status || "NO_ELEMENT",
        details: "No valid route found from base to pickup",
      });
    }

    const durationSeconds =
      element.duration_in_traffic?.value ?? element.duration?.value ?? 0;
    const durationMinutes = Math.ceil(durationSeconds / 60);

    const distanceMeters = element.distance?.value ?? 0;
    const distanceMilesNum = distanceMeters / 1609.344;
    const distanceMiles = Math.round(distanceMilesNum * 10) / 10; // number w/ 0.1 precision
    const distanceText = element.distance?.text || `${distanceMiles.toFixed(1)} mi`;

    // Add prep time for driver
    const prepTimeMinutes = 2;
    const totalEtaMinutes = durationMinutes + prepTimeMinutes;

    // --- Time formatting in America/Denver (handles DST automatically) ---
    const ASPEN_TZ = "America/Denver";
    const nowUtcMs = Date.now();
    const arrivalUtcMs = nowUtcMs + totalEtaMinutes * 60 * 1000;

    const fmtLocalTime = (ms, tz = ASPEN_TZ) =>
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: tz,
      }).format(ms);

    const estimated_arrival_time = fmtLocalTime(arrivalUtcMs, ASPEN_TZ);
    const now_local_time = fmtLocalTime(nowUtcMs, ASPEN_TZ);

    // --- Friendly ETA summary buckets ---
    let etaSummary;
    if (totalEtaMinutes <= 5) {
      etaSummary = "about 5 minutes";
    } else if (totalEtaMinutes <= 10) {
      etaSummary = "about 10 minutes";
    } else if (totalEtaMinutes <= 15) {
      etaSummary = "about 10-15 minutes";
    } else if (totalEtaMinutes <= 20) {
      etaSummary = "about 15-20 minutes";
    } else if (totalEtaMinutes <= 30) {
      etaSummary = "about 20-30 minutes";
    } else {
      etaSummary = `about ${totalEtaMinutes} minutes`;
    }

    // --- Build response ---
    const nowIsoUtc = new Date(nowUtcMs).toISOString();
    const arrivalIsoUtc = new Date(arrivalUtcMs).toISOString();

    return res.status(200).json({
      ok: true,

      // Dispatch info
      dispatch_from: HM_BASE.address,
      dispatch_lat: HM_BASE.lat,
      dispatch_lng: HM_BASE.lng,

      // Pickup info
      pickup_address: pickup_address || null,
      pickup_lat: pLat,
      pickup_lng: pLng,

      // Metrics
      drive_time_minutes: durationMinutes,
      prep_time_minutes: prepTimeMinutes,
      total_eta_minutes: totalEtaMinutes,

      // Distance
      distance_miles: distanceMiles, // number
      distance_text: distanceText,   // string

      // Times
      timezone: ASPEN_TZ,
      now_local_time,
      estimated_arrival_time, // formatted in America/Denver
      now_utc_iso: nowIsoUtc,
      arrival_utc_iso: arrivalIsoUtc,

      // Voice-friendly summary
      eta_summary: etaSummary,

      // Metadata
      calculated_at: nowIsoUtc,
    });
  } catch (error) {
    console.error("[dispatch-eta] error:", error);
    return res.status(500).json({
      ok: false,
      error: "DISPATCH_ETA_FAILED",
      message: error?.message,
    });
  }
}