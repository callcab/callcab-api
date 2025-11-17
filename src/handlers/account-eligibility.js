import { parseTime, isWithinTimeWindow, jsonResponse } from '../lib/utils.js';

export async function handleAccountEligibility(request, env) {
  try {
    const body = await request.json();
    const {
      pickup_address,
      pickup_lat,
      pickup_lng,
      pickup_location_id,
      destination_address,
      destination_lat,
      destination_lng,
      destination_location_id,
      pickup_time,
      passenger_count = 1
    } = body;

    if (!pickup_lat || !pickup_lng || !destination_lat || !destination_lng) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_COORDINATES',
        message: 'Both pickup and destination coordinates required'
      }, 400);
    }

    // Check all account programs
    const checks = [
      checkHighlandsDistrict(body),
      checkFiveTrees(body),
      checkSnowmassDialARide(body),
      checkAspenCountryInn(body)
    ];

    for (const result of checks) {
      if (result.eligible) {
        return jsonResponse(result);
      }
    }

    // No special account - regular metered ride
    return jsonResponse({
      ok: true,
      eligible: false,
      account_type: 'REGULAR_METERED',
      claire_script: null,
      skip_fare_quote: false
    });

  } catch (error) {
    console.error('[account-eligibility] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'CHECK_FAILED',
      message: error.message
    }, 500);
  }
}

// Highlands District check
function checkHighlandsDistrict(params) {
  const { pickup_address, pickup_location_id, destination_location_id, pickup_time } = params;
  
  const isHighlandsPickup = isInHighlandsDistrict(pickup_address, pickup_location_id);
  if (!isHighlandsPickup) return { eligible: false };
  
  const eligibleDestinations = [
    'downtown-aspen-core', 'clarks-market-aspen', 'city-market-aspen',
    'ase-airport', 'atlantic-aviation-ase', 'aspen-base-ops', 'aspen-valley-hospital'
  ];
  
  const isEligibleDestination = eligibleDestinations.includes(destination_location_id) ||
    isInDowntownAspenCore(params.destination_lat, params.destination_lng);
  
  if (!isEligibleDestination) {
    return { eligible: false, reason: 'DESTINATION_NOT_COVERED' };
  }
  
  const time = parseTime(pickup_time);
  const restrictions = getHighlandsTimeRestrictions(destination_location_id);
  
  if (!isWithinTimeWindow(time, restrictions)) {
    return { eligible: false, reason: 'OUTSIDE_TIME_WINDOW' };
  }
  
  return {
    ok: true,
    eligible: true,
    account_id: "5095",
    account_name: "Aspen Highlands District HOA",
    account_type: "FREE_RIDE",
    claire_script: "This ride's covered by your Highlands District HOA. Tips are cash if you'd like.",
    instructions_note: "HOA Highlands - FREE RIDE, cash tips only",
    skip_fare_quote: true
  };
}

// Five Trees check
function checkFiveTrees(params) {
  const { pickup_address, pickup_location_id, destination_location_id, pickup_time } = params;
  
  const isFiveTreesPickup = isInFiveTrees(pickup_address, pickup_location_id);
  if (!isFiveTreesPickup) return { eligible: false };
  
  const eligibleDestinations = [
    'downtown-aspen-core', 'clarks-market-aspen', 'city-market-aspen',
    'ase-airport', 'atlantic-aviation-ase', 'aspen-base-ops', 'aspen-valley-hospital'
  ];
  
  const isEligibleDestination = eligibleDestinations.includes(destination_location_id) ||
    isInDowntownAspenCore(params.destination_lat, params.destination_lng);
  
  if (!isEligibleDestination) return { eligible: false };
  
  const time = parseTime(pickup_time);
  const restrictions = getHighlandsTimeRestrictions(destination_location_id);
  
  if (!isWithinTimeWindow(time, restrictions)) return { eligible: false };
  
  return {
    ok: true,
    eligible: true,
    account_id: "5140",
    account_name: "Five Trees",
    account_type: "FREE_RIDE",
    claire_script: "This ride's covered by Five Trees. Tips are cash if you'd like.",
    instructions_note: "Five Trees - FREE RIDE, cash tips only",
    skip_fare_quote: true
  };
}

// Snowmass Dial-a-Ride check
function checkSnowmassDialARide(params) {
  const { pickup_lat, pickup_lng, destination_lat, destination_lng, pickup_time, passenger_count } = params;
  
  const pickupInSnowmass = isInSnowmassVillage(pickup_lat, pickup_lng);
  const destInSnowmass = isInSnowmassVillage(destination_lat, destination_lng);
  
  if (!pickupInSnowmass || !destInSnowmass) return { eligible: false };
  
  const time = parseTime(pickup_time);
  if (!isWithinTimeWindow(time, { start: '08:00', end: '21:00' })) {
    return { eligible: false };
  }
  
  return {
    ok: true,
    eligible: true,
    account_id: "5060",
    account_name: "Snowmass Village Dial-a-Ride",
    account_type: "SUBSIDIZED",
    passenger_payment: "$1 per person",
    claire_script: "This qualifies for Snowmass Village Dial-a-Ride. It's just a dollar per person, and we collect that when the driver picks you up.",
    instructions_note: `SNOWMASS DIAL-A-RIDE - Collect $${passenger_count} ($1 per person x ${passenger_count} passengers)`,
    skip_fare_quote: true
  };
}

// Aspen Country Inn check
function checkAspenCountryInn(params) {
  const { pickup_address, pickup_location_id, destination_location_id } = params;
  
  const isAciPickup = pickup_location_id === 'aspen-country-inn' ||
    (pickup_address || '').toLowerCase().includes('aspen country inn');
  
  const isAciDropoff = destination_location_id === 'aspen-country-inn' ||
    (params.destination_address || '').toLowerCase().includes('aspen country inn');
  
  if (!isAciPickup && !isAciDropoff) return { eligible: false };
  
  const crossingHighway = isCrossingHighway82(params);
  if (!crossingHighway) return { eligible: false };
  
  return {
    ok: true,
    eligible: true,
    account_id: "5005",
    account_name: "Aspen Country Inn",
    account_type: "FREE_RIDE_CONDITIONAL",
    claire_script: "Since you're crossing the highway, Aspen Country Inn covers this ride. Tips are cash if you'd like.",
    instructions_note: "ASPEN COUNTRY INN - Free ride (crossing Hwy 82), cash tips only",
    skip_fare_quote: true
  };
}

// Helper functions
function isInHighlandsDistrict(address, location_id) {
  const highlandsIds = ['maroon-creek-rd-highlands', 'white-river-dr-highlands', 'ritz-carlton-club-highlands'];
  if (highlandsIds.includes(location_id)) return true;
  
  const keywords = ['maroon creek road', 'white river drive', 'ritz-carlton club', 'aspen highlands'];
  return keywords.some(kw => (address || '').toLowerCase().includes(kw));
}

function isInFiveTrees(address, location_id) {
  const fiveTreesIds = ['moore-drive-five-trees', 'bus-barn-lane-five-trees'];
  if (fiveTreesIds.includes(location_id)) return true;
  
  const keywords = ['moore drive', 'bus barn lane'];
  return keywords.some(kw => (address || '').toLowerCase().includes(kw));
}

function isInDowntownAspenCore(lat, lng) {
  return lat >= 39.1895 && lat <= 39.1925 && lng >= -106.8210 && lng <= -106.8150;
}

function isInSnowmassVillage(lat, lng) {
  return lat >= 39.200 && lat <= 39.230 && lng >= -106.970 && lng <= -106.930;
}

function getHighlandsTimeRestrictions(destination_id) {
  if (destination_id?.includes('downtown') || destination_id?.includes('market')) {
    return { start: '08:00', end: '00:00' };
  }
  return { start: '05:20', end: '00:00' };
}

function isCrossingHighway82(params) {
  const aciLat = 39.2150;
  const aspenCoreLat = 39.1911;
  
  return (params.pickup_lat > aciLat && params.destination_lat < aspenCoreLat) ||
         (params.pickup_lat < aspenCoreLat && params.destination_lat > aciLat);
}