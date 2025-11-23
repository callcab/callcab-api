// pages/api/google-validate-address.js
// HYBRID APPROACH: Places API (businesses/landmarks) + Geocoding API (addresses)

export default async function handler(req, res) {
  // CORS headers
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

    const { query, regionBias, strictServiceArea, components, allowOutsideServiceArea } = req.body;

    if (!query) {
      return res.status(400).json({ 
        ok: false, 
        error: 'MISSING_QUERY',
        details: 'query parameter is required' 
      });
    }

    // Service area center (Aspen, CO)
    const serviceCenter = {
      lat: regionBias?.lat || 39.1911,
      lng: regionBias?.lng || -106.8175,
      radiusMeters: regionBias?.radiusMeters || 80000 // 80km ~= 50 miles
    };

    // STEP 1: Try Places API first (best for businesses, landmarks, POIs)
    const placesResult = await tryPlacesAPI(query, serviceCenter, key);
    
    if (placesResult.success) {
      console.log('[validate-address] Found via Places API:', placesResult.data.name);
      return res.status(200).json(processResult(
        placesResult.data, 
        serviceCenter, 
        strictServiceArea, 
        allowOutsideServiceArea,
        'places'
      ));
    }

    // STEP 2: Fall back to Geocoding API (for street addresses)
    const geocodingResult = await tryGeocodingAPI(query, serviceCenter, components, key);
    
    if (geocodingResult.success) {
      console.log('[validate-address] Found via Geocoding API:', geocodingResult.data.address);
      return res.status(200).json(processResult(
        geocodingResult.data, 
        serviceCenter, 
        strictServiceArea, 
        allowOutsideServiceArea,
        'geocoding'
      ));
    }

    // STEP 3: No results from either API
    return res.status(200).json({
      ok: true,
      is_valid: false,
      error: 'NO_RESULTS',
      message: 'Could not find that location. Please try a nearby cross street or landmark.',
      query: query,
      suggestions: []
    });

  } catch (err) {
    console.error('[validate-address] error:', err);
    return res.status(500).json({ 
      ok: false, 
      error: 'VALIDATION_FAILED', 
      message: err?.message || 'Unknown error' 
    });
  }
}

/**
 * Try Google Places API (Text Search)
 * Best for: Businesses, landmarks, POIs, airports
 */
async function tryPlacesAPI(query, serviceCenter, key) {
  try {
    // Use Places API (New) Text Search
    const params = new URLSearchParams({
      textQuery: query,
      locationBias: `circle:${serviceCenter.radiusMeters}@${serviceCenter.lat},${serviceCenter.lng}`,
      key: key
    });

    const url = `https://places.googleapis.com/v1/places:searchText`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.id,places.types,places.addressComponents'
      },
      body: JSON.stringify({
        textQuery: query,
        locationBias: {
          circle: {
            center: {
              latitude: serviceCenter.lat,
              longitude: serviceCenter.lng
            },
            radius: serviceCenter.radiusMeters
          }
        }
      })
    });

    if (!response.ok) {
      console.log('[Places API] Error:', response.status);
      return { success: false };
    }

    const data = await response.json();
    const places = data.places || [];

    if (places.length === 0) {
      return { success: false };
    }

    // Get top result
    const place = places[0];
    
    return {
      success: true,
      data: {
        name: place.displayName?.text || null,
        address: place.formattedAddress,
        lat: place.location.latitude,
        lng: place.location.longitude,
        place_id: place.id,
        types: place.types || [],
        address_components: parseAddressComponents(place.addressComponents || [])
      }
    };

  } catch (err) {
    console.error('[Places API] Error:', err);
    return { success: false };
  }
}

/**
 * Try Google Geocoding API
 * Best for: Street addresses with numbers
 */
async function tryGeocodingAPI(query, serviceCenter, components, key) {
  try {
    const params = new URLSearchParams({
      address: query,
      key: key,
      region: 'US'
    });

    // Add component restrictions
    if (components) {
      params.set('components', components);
    } else {
      params.set('components', 'country:US|administrative_area:CO');
    }

    // Add location bias
    params.set('location', `${serviceCenter.lat},${serviceCenter.lng}`);
    params.set('radius', serviceCenter.radiusMeters.toString());

    const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' || !data.results?.length) {
      return { success: false };
    }

    const result = data.results[0];
    const loc = result.geometry.location;

    // Extract name (for establishments)
    let placeName = null;
    if (result.types.includes('establishment') || 
        result.types.includes('point_of_interest')) {
      placeName = result.formatted_address.split(',')[0];
    }

    return {
      success: true,
      data: {
        name: placeName,
        address: result.formatted_address,
        lat: loc.lat,
        lng: loc.lng,
        place_id: result.place_id,
        types: result.types,
        address_components: parseAddressComponents(result.address_components)
      }
    };

  } catch (err) {
    console.error('[Geocoding API] Error:', err);
    return { success: false };
  }
}

/**
 * Parse address components into standard format
 */
function parseAddressComponents(components) {
  const parsed = {};
  
  components.forEach(comp => {
    const types = comp.types || [];
    const longName = comp.longName || comp.long_name;
    const shortName = comp.shortName || comp.short_name;
    
    if (types.includes('locality')) parsed.city = longName;
    if (types.includes('administrative_area_level_2')) parsed.county = longName;
    if (types.includes('administrative_area_level_1')) parsed.state = shortName;
    if (types.includes('postal_code')) parsed.zip = longName;
    if (types.includes('country')) parsed.country = shortName;
  });

  return parsed;
}

/**
 * Process result and determine service area status
 */
function processResult(data, serviceCenter, strictServiceArea, allowOutsideServiceArea, source) {
  // Calculate distance from service center
  const distanceMeters = calculateDistance(
    serviceCenter.lat,
    serviceCenter.lng,
    data.lat,
    data.lng
  );
  const distanceMiles = distanceMeters / 1609.344;

  // Determine if in service area
  const isInServiceArea = checkServiceArea(
    distanceMiles,
    data.address_components,
    data.types
  );

  // Calculate confidence
  const confidence = calculateConfidence(data, distanceMiles, source);

  // Build response
  const response = {
    ok: true,
    is_valid: true,
    best_match_name: data.name,
    normalized_address: data.address,
    lat: data.lat,
    lng: data.lng,
    place_id: data.place_id,
    place_types: data.types,
    address_components: data.address_components,
    distance_from_service_center_miles: Math.round(distanceMiles * 10) / 10,
    is_in_service_area: isInServiceArea,
    confidence: confidence,
    source: source
  };

  // Check strict service area
  if (strictServiceArea && !allowOutsideServiceArea && !isInServiceArea) {
    response.warning = 'OUTSIDE_SERVICE_AREA';
    response.message = 'Location is outside normal service area. Please confirm.';
  }

  return response;
}

/**
 * Check if location is in service area
 */
function checkServiceArea(distanceMiles, components, types) {
  // Within 30 miles = definitely in service area
  if (distanceMiles <= 30) return true;

  // Check counties
  const servedCounties = ['Pitkin County', 'Eagle County', 'Garfield County'];
  if (components.county && servedCounties.some(c => components.county.includes(c))) {
    return distanceMiles <= 80;
  }

  // Check cities
  const servedCities = [
    'Aspen', 'Snowmass Village', 'Basalt', 'Carbondale',
    'Glenwood Springs', 'Vail', 'Beaver Creek', 'Avon',
    'Edwards', 'Eagle', 'Gypsum', 'Woody Creek', 'El Jebel'
  ];
  if (components.city && servedCities.some(c => components.city.includes(c))) {
    return true;
  }

  // Airports always accepted (within reason)
  if (types.includes('airport')) {
    return distanceMiles <= 200;
  }

  return false;
}

/**
 * Calculate confidence score
 */
function calculateConfidence(data, distanceMiles, source) {
  let confidence = 1.0;

  // Places API results generally more confident for businesses
  if (source === 'places' && data.name) {
    confidence = 0.95;
  } else if (source === 'geocoding') {
    confidence = 0.85;
  }

  // Penalize by distance
  if (distanceMiles > 50) {
    confidence -= 0.2;
  } else if (distanceMiles > 30) {
    confidence -= 0.1;
  }

  // Boost for specific types
  if (data.types.includes('airport')) confidence += 0.05;
  if (data.types.includes('lodging')) confidence += 0.05;
  if (data.types.includes('restaurant')) confidence += 0.03;

  return Math.max(0, Math.min(1, confidence));
}

/**
 * Calculate distance between coordinates (Haversine)
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
            Math.cos(φ1) * Math.cos(φ2) *
            Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

  return R * c;
}