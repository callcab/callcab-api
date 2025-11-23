// pages/api/route-quote.js
// Enhanced route quote with traffic awareness, route classification, and comprehensive data
// Type-safe version: coerces pricing inputs to numbers and guards all .toFixed(...)

export default async function handler(req, res) {
  // CORS for Vapi dashboard testing
  const ALLOW_ORIGIN = '*';
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    const key = process.env.GOOGLE_MAPS_API_KEY;
    if (!key) {
      return res.status(500).json({ ok: false, error: 'NO_GOOGLE_MAPS_API_KEY' });
    }

    // Helpers
    const toNum = (v, def) => {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      return Number.isFinite(n) ? Number(n) : def;
    };
    const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

    // Parse and normalize input
    const body = req.body || {};
    const pickup = body.pickup || {};
    const dropoff = body.dropoff || {};
    const pricing = body.pricing || {};

    // Convert string coordinates to numbers
    ['lat', 'lng'].forEach(field => {
      if (typeof pickup[field] === 'string') pickup[field] = parseFloat(pickup[field]);
      if (typeof dropoff[field] === 'string') dropoff[field] = parseFloat(dropoff[field]);
    });

    // Validate required coordinates (be explicit: must be finite)
    if (!Number.isFinite(pickup.lat) || !Number.isFinite(pickup.lng) ||
        !Number.isFinite(dropoff.lat) || !Number.isFinite(dropoff.lng)) {
      return res.status(400).json({ 
        ok: false, 
        error: 'MISSING_COORDS', 
        details: 'pickup.lat/lng and dropoff.lat/lng are required numeric values' 
      });
    }

    // Validate coordinate ranges
    if (Math.abs(pickup.lat) > 90 || Math.abs(dropoff.lat) > 90 ||
        Math.abs(pickup.lng) > 180 || Math.abs(dropoff.lng) > 180) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_COORDS',
        details: 'Coordinates are out of valid range'
      });
    }

    // Build Distance Matrix API request with real-time traffic
    const params = new URLSearchParams({
      origins: `${pickup.lat},${pickup.lng}`,
      destinations: `${dropoff.lat},${dropoff.lng}`,
      units: 'imperial',
      mode: 'driving',
      region: 'US',
      departure_time: 'now', // real-time traffic
      traffic_model: 'best_guess',
      key: key
    });

    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params.toString()}`;
    const response = await fetch(url);
    const distanceMatrix = await response.json();

    // Handle Google API errors
    if (distanceMatrix?.status !== 'OK') {
      console.error('[route-quote] Google API error:', distanceMatrix);
      return res.status(502).json({
        ok: false,
        error: 'GOOGLE_MATRIX_ERROR',
        google_status: distanceMatrix?.status,
        google_error: distanceMatrix?.error_message || null,
        details: 'Failed to retrieve route data from Google Maps'
      });
    }

    // Extract route element
    const row = distanceMatrix?.rows?.[0];
    const element = row?.elements?.[0];

    if (!element || element.status !== 'OK') {
      return res.status(200).json({
        ok: false,
        error: 'ROUTE_NOT_FOUND',
        element_status: element?.status || 'NO_ELEMENT',
        details: 'No valid route found between pickup and dropoff locations',
        pickup: { lat: pickup.lat, lng: pickup.lng, address: pickup.address || null },
        dropoff: { lat: dropoff.lat, lng: dropoff.lng, address: dropoff.address || null }
      });
    }

    // Extract distance and duration data
    const distanceMeters = toNum(element.distance?.value, 0);
    const baseDurationSeconds = toNum(element.duration?.value, 0);
    const durationSecTraffic = toNum(element.duration_in_traffic?.value, baseDurationSeconds);
    const durationSeconds = Math.max(durationSecTraffic, baseDurationSeconds);

    const distanceMiles = distanceMeters / 1609.344;
    const durationMinutes = durationSeconds / 60;
    const baseDurationMinutes = baseDurationSeconds / 60;

    // Calculate traffic delay
    const trafficDelayMinutes = durationMinutes - baseDurationMinutes;
    const hasSignificantTraffic = trafficDelayMinutes > 3;

    // Get formatted text from Google
    const distanceText = element.distance?.text || `${distanceMiles.toFixed(1)} mi`;
    const durationText = element.duration_in_traffic?.text || element.duration?.text || 
                         `${Math.round(durationMinutes)} mins`;

    // ---- Pricing (type-safe) ----
    // Defaults
    const defaults = {
      baseFare: 5.00,
      perMile: 4.25,
      perMinute: 0.75,
      minimumFare: 20.00,
      airportFee: 5.00,
      bookingFee: 0.00,
      longTripAdjMiles: 50,
      longTripDiscountPct: 0,
      bufferPctLow: 0.05,
      bufferPctHigh: 0.15
    };

    // Merge & coerce all pricing fields to numbers
    const config = {
      baseFare: toNum(pricing.baseFare, defaults.baseFare),
      perMile: toNum(pricing.perMile, defaults.perMile),
      perMinute: toNum(pricing.perMinute, defaults.perMinute),
      minimumFare: toNum(pricing.minimumFare, defaults.minimumFare),
      airportFee: toNum(pricing.airportFee, defaults.airportFee),
      bookingFee: toNum(pricing.bookingFee, defaults.bookingFee),
      longTripAdjMiles: toNum(pricing.longTripAdjMiles, defaults.longTripAdjMiles),
      longTripDiscountPct: toNum(pricing.longTripDiscountPct, defaults.longTripDiscountPct),
      bufferPctLow: toNum(pricing.bufferPctLow, defaults.bufferPctLow),
      bufferPctHigh: toNum(pricing.bufferPctHigh, defaults.bufferPctHigh)
    };

    // Check for airport locations in pickup or dropoff addresses (string safe)
    const addrA = (pickup.address || '').toLowerCase();
    const addrB = (dropoff.address || '').toLowerCase();
    const combinedAddresses = `${addrA} ${addrB}`;
    const hasAirport = /aspen.*airport|pitkin.*airport|sardy.*field|\base\b|eagle.*airport|\bege\b|denver.*airport|\bden\b/i.test(combinedAddresses);

    // Calculate base fare: base + (distance × rate) + (time × rate) + booking fee
    let rawFare = config.baseFare +
                  (distanceMiles * config.perMile) +
                  (durationMinutes * config.perMinute) +
                  config.bookingFee;

    // Airport fee (numeric & optional)
    if (hasAirport) {
      rawFare += config.airportFee; // config.airportFee is guaranteed numeric
    }

    // Apply long-distance discount if applicable
    const isLongDistance = distanceMiles > config.longTripAdjMiles;
    let discountApplied = 0;
    if (isLongDistance && config.longTripDiscountPct > 0) {
      discountApplied = rawFare * (config.longTripDiscountPct / 100);
      rawFare -= discountApplied;
    }

    // Enforce minimum fare
    const totalFare = Math.max(rawFare, config.minimumFare);

    // Calculate fare range with buffer percentages
    const fareLow = round2(totalFare * (1 - config.bufferPctLow));
    const fareHigh = round2(totalFare * (1 + config.bufferPctHigh));
    const fareMid = round2((fareLow + fareHigh) / 2);

    // Analyze route characteristics for better context
    const routeInfo = analyzeRoute(
      distanceMiles,
      durationMinutes,
      pickup.address || '',
      dropoff.address || '',
      hasAirport
    );

    // Build comprehensive response
    const responseData = {
      ok: true,
      
      // Location information
      pickup: {
        lat: pickup.lat,
        lng: pickup.lng,
        address: pickup.address || null
      },
      dropoff: {
        lat: dropoff.lat,
        lng: dropoff.lng,
        address: dropoff.address || null
      },
      
      // Distance and time
      distance_miles: round2(distanceMiles),
      duration_minutes: Math.round(durationMinutes),
      distance_text: distanceText,
      duration_text: durationText,
      
      // Traffic information
      has_traffic_delay: hasSignificantTraffic,
      traffic_delay_minutes: Math.max(0, Math.round(trafficDelayMinutes)),
      base_duration_minutes: Math.round(baseDurationMinutes),
      
      // Fare estimates
      fare_estimate_low: fareLow,
      fare_estimate_high: Math.max(fareHigh, fareLow),
      fare_estimate_mid: fareMid,
      
      // Route characteristics
      is_long_distance: isLongDistance,
      has_airport_fee: hasAirport,
      route_type: routeInfo.type,
      route_description: routeInfo.description,
      
      // Additional details
      note: "Estimates only; actual fares are metered and may vary with traffic, weather, and wait-time.",
      pricing_details: buildPricingDetails(hasAirport, config.airportFee, isLongDistance, discountApplied),
      
      // Metadata
      timestamp: new Date().toISOString(),
      
      // Debug info (only in development)
      _debug: process.env.NODE_ENV === 'development' ? {
        rawFare: round2(rawFare),
        minimumFareApplied: totalFare === config.minimumFare,
        discountApplied: round2(discountApplied),
        config: config
      } : undefined
    };

    return res.status(200).json(responseData);

  } catch (err) {
    console.error('[route-quote] error:', err);
    return res.status(500).json({ 
      ok: false, 
      error: 'ROUTE_QUOTE_FAILED', 
      message: err?.message || 'Unknown error',
      details: 'An internal error occurred while calculating the route and fare'
    });
  }
}

/**
 * Analyze route to determine type and provide context
 */
function analyzeRoute(miles, minutes, pickupAddr, dropoffAddr, hasAirport) {
  const addresses = `${pickupAddr || ''} ${dropoffAddr || ''}`.toLowerCase();
  
  let type = 'standard';
  let description = '';

  // Very long distance (>100 miles)
  if (miles > 100) {
    type = 'very_long_distance';
    description = 'Long-distance trip requiring advance booking and coordination';
  } 
  // Long distance (50-100 miles)
  else if (miles > 50) {
    type = 'long_distance';
    description = 'Extended trip across mountain passes';
  } 
  // Airport transfers
  else if (hasAirport) {
    if (addresses.includes('denver') || /\bden\b/.test(addresses)) {
      type = 'airport_transfer_den';
      description = 'Denver International Airport transfer (very long distance)';
    } else if (addresses.includes('eagle') || /\bege\b/.test(addresses)) {
      type = 'airport_transfer_ege';
      description = 'Eagle County Airport transfer';
    } else {
      type = 'airport_transfer_ase';
      description = 'Aspen Airport transfer';
    }
  }
  // Valley corridor (Aspen/Snowmass)
  else if ((addresses.includes('snowmass') && addresses.includes('aspen')) ||
           (addresses.includes('aspen') && addresses.includes('snowmass'))) {
    type = 'valley_corridor';
    description = 'Standard Aspen-Snowmass valley route';
  }
  // Down valley
  else if (addresses.includes('glenwood') || addresses.includes('carbondale') || 
           addresses.includes('basalt') || addresses.includes('el jebel')) {
    type = 'down_valley';
    description = 'Down-valley route along Highway 82';
  }
  // Vail area
  else if (addresses.includes('vail') || addresses.includes('beaver creek') || 
           addresses.includes('avon') || addresses.includes('edwards')) {
    type = 'vail_area';
    description = 'Vail Valley area route';
  }
  // Local short trip
  else if (miles < 5) {
    type = 'local';
    description = 'Local area transport';
  }
  // Standard valley transport
  else {
    type = 'standard';
    description = 'Standard valley transport';
  }

  return { type, description };
}

/**
 * Build human-readable pricing details
 * Guards against non-numeric inputs to avoid `.toFixed` crashes.
 */
function buildPricingDetails(hasAirport, airportFee, isLongDistance, discountApplied) {
  const details = [];
  
  if (hasAirport) {
    const feeNum = Number(airportFee);
    details.push(
      Number.isFinite(feeNum)
        ? `Includes $${feeNum.toFixed(2)} airport fee`
        : 'Includes airport fee'
    );
  }
  
  const discNum = Number(discountApplied);
  if (isLongDistance && Number.isFinite(discNum) && discNum > 0) {
    details.push(`Long-distance discount of $${discNum.toFixed(2)} applied`);
  }
  
  return details.length > 0 ? details.join('; ') : null;
}