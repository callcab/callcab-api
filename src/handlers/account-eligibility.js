/**
 * Account Eligibility Service v2.0
 * Registry-based approach for all 22 account programs
 * 
 * This service loads the accounts-registry.json and queries it
 * to determine which accounts apply to a given booking.
 */

import { loadAccountRegistry } from '../lib/account-registry.js';

/**
 * Main handler for account eligibility checks
 */
export async function handleAccountEligibility(request, env) {
  try {
    const body = await request.json();
    const {
      // Location data
      pickup_lat,
      pickup_lng,
      pickup_address,
      pickup_location_id,
      destination_lat,
      destination_lng,
      destination_address,
      destination_location_id,
      
      // Booking details
      pickup_time,
      passenger_count = 1,
      
      // NEW: Optional context from Claire
      account_hints = [],      // e.g., ['tipsy', 'senior', 'hotel-jerome']
      customer_context = {}    // e.g., { is_senior: true, has_voucher: true }
    } = body;

    // Validate required fields
    if (!pickup_lat || !pickup_lng || !destination_lat || !destination_lng) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_COORDINATES',
        message: 'Both pickup and destination coordinates required'
      }, 400);
    }

    // Load account registry (from JSON file or environment variable)
    let registry;
    try {
      const registryPath = env.ACCOUNT_REGISTRY_PATH || './data/accounts-registry.json';
      registry = await loadAccountRegistry(registryPath);
    } catch (error) {
      console.error('[account-eligibility] Failed to load registry:', error);
      return jsonResponse({
        ok: false,
        error: 'REGISTRY_LOAD_FAILED',
        message: 'Could not load account registry'
      }, 500);
    }

    // Find all eligible accounts
    const eligibleAccounts = registry.findEligible({
      pickup_lat,
      pickup_lng,
      pickup_address,
      pickup_location_id,
      destination_lat,
      destination_lng,
      destination_address,
      destination_location_id,
      pickup_time,
      passenger_count,
      account_hints,
      customer_context
    });

    // Get primary account (highest priority)
    const primaryAccount = eligibleAccounts[0] || registry.getDefault();
    
    // Format response
    const response = registry.formatResponse(primaryAccount, { passenger_count });

    // Add all eligible accounts (for disambiguation if needed)
    response.all_eligible = eligibleAccounts.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      priority: a.priority,
      trigger_type: a.trigger_type
    }));

    // Add debug info if requested
    if (body.debug) {
      response.debug = {
        checked_accounts: registry.accounts.length,
        geo_triggered_checked: registry.getByTriggerType('geo_automatic').length,
        hints_provided: account_hints,
        eligible_count: eligibleAccounts.length
      };
    }

    return jsonResponse(response);

  } catch (error) {
    console.error('[account-eligibility] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'CHECK_FAILED',
      message: error.message,
      stack: env.DEBUG ? error.stack : undefined
    }, 500);
  }
}

/**
 * Helper: JSON response with CORS headers
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

/**
 * Handle OPTIONS preflight requests
 */
export async function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
}

/**
 * Example usage for testing
 */
export const examples = {
  // Example 1: Highlands District pickup
  highlandsToAirport: {
    pickup_address: "123 Maroon Creek Road, Aspen Highlands",
    pickup_lat: 39.1825,
    pickup_lng: -106.8550,
    destination_address: "Aspen Airport",
    destination_lat: 39.2223,
    destination_lng: -106.8694,
    pickup_time: "10:00 am",
    passenger_count: 2
  },
  
  // Example 2: Tipsy Taxi with hint
  tipsyTaxi: {
    pickup_address: "Hotel Jerome",
    pickup_lat: 39.1911,
    pickup_lng: -106.8175,
    destination_address: "123 Oak Street",
    destination_lat: 39.1900,
    destination_lng: -106.8200,
    pickup_time: "now",
    passenger_count: 1,
    account_hints: ["tipsy"]
  },
  
  // Example 3: Limelight Hotel (should ask)
  limelightHotel: {
    pickup_address: "Limelight Hotel Aspen",
    pickup_location_id: "limelight-hotel-aspen",
    pickup_lat: 39.1880,
    pickup_lng: -106.8250,
    destination_address: "Aspen Airport",
    destination_lat: 39.2223,
    destination_lng: -106.8694,
    pickup_time: "tomorrow 8am",
    passenger_count: 1
  },
  
  // Example 4: Regular ride (no account)
  regularRide: {
    pickup_address: "600 E Cooper Ave",
    pickup_lat: 39.1903,
    pickup_lng: -106.8167,
    destination_address: "Matsuhisa Restaurant",
    destination_lat: 39.1895,
    destination_lng: -106.8180,
    pickup_time: "6:30 pm",
    passenger_count: 2
  }
};

/**
 * Test endpoint
 */
export async function testRegistry(env) {
  const registryPath = env.ACCOUNT_REGISTRY_PATH || './data/accounts-registry.json';
  const registry = await loadAccountRegistry(registryPath);
  
  return {
    loaded: true,
    version: registry.version,
    total_accounts: registry.accounts.length,
    accounts_by_type: {
      geo_automatic: registry.getByTriggerType('geo_automatic').length,
      customer_mention: registry.getByTriggerType('customer_mention').length,
      location_optional: registry.getByTriggerType('location_optional').length,
      do_not_volunteer: registry.getByTriggerType('do_not_volunteer').length
    },
    sample_account: registry.accounts[0]
  };
}