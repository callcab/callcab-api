import { loadAccountRegistry } from '../lib/account-registry.js';
import { jsonResponse } from '../lib/utils.js';

/**
 * Account Eligibility Service v2.0
 * Uses registry-based approach for all accounts
 */

export async function handleAccountEligibility(request, env) {
  try {
    const body = await request.json();
    const {
      pickup_lat,
      pickup_lng,
      pickup_address,
      pickup_location_id,
      destination_lat,
      destination_lng,
      destination_address,
      destination_location_id,
      pickup_time,
      passenger_count = 1,
      
      // NEW: Optional context from Claire
      account_hints = [],      // ['tipsy', 'senior', 'hotel-jerome']
      customer_context = {}    // { is_senior: true, has_voucher: true }
    } = body;

    // Validate required fields
    if (!pickup_lat || !pickup_lng || !destination_lat || !destination_lng) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_COORDINATES',
        message: 'Both pickup and destination coordinates required'
      }, 400);
    }

    // Load account registry
    const registryPath = env.ACCOUNT_REGISTRY_PATH || '../data/accounts-registry.json';
    const registry = await loadAccountRegistry(registryPath);

    // Find eligible accounts
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

    // Return best match (highest priority)
    const primaryAccount = eligibleAccounts[0] || registry.getDefault();
    const response = registry.formatResponse(primaryAccount, { passenger_count });

    // Add all eligible accounts for disambiguation
    response.all_eligible = eligibleAccounts.map(a => ({
      id: a.id,
      name: a.name,
      type: a.type,
      priority: a.priority
    }));

    return jsonResponse(response);

  } catch (error) {
    console.error('[account-eligibility] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'CHECK_FAILED',
      message: error.message
    }, 500);
  }
}