// src/lib/account-registry.js
// CLAIRE v4.2 - Cloudflare Workers Compatible
// Includes loadAccountRegistry for backward compatibility

import accountsData from '../data/accounts-registry.json';

export class AccountRegistry {
  constructor(registryData) {
    if (!registryData) {
      throw new Error('[AccountRegistry] No registry data provided');
    }
    
    this.accounts = registryData.accounts || [];
    this.version = registryData.version;
    
    console.log(`[AccountRegistry] Initialized: ${this.accounts.length} accounts, version ${this.version}`);
  }

  findEligible(params) {
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
      account_hints = []
    } = params;

    let eligible = [];

    // Check geo-triggered accounts (automatic)
    const geoAccounts = this.accounts.filter(a => a.trigger_type === 'geo_automatic');
    for (const account of geoAccounts) {
      if (this.checkEligibility(account, params)) {
        eligible.push(account);
      }
    }

    // Check hint-triggered accounts
    if (account_hints.length > 0) {
      for (const hint of account_hints) {
        const account = this.findByHint(hint);
        if (account && !eligible.find(a => a.id === account.id)) {
          if (this.checkEligibility(account, params)) {
            eligible.push(account);
          }
        }
      }
    }

    // Check location-triggered accounts (hotel pickups)
    if (pickup_location_id) {
      const locationAccounts = this.accounts.filter(a => 
        a.trigger_type === 'location_optional' &&
        a.eligibility?.pickup_location_ids?.includes(pickup_location_id)
      );
      for (const account of locationAccounts) {
        if (!eligible.find(a => a.id === account.id)) {
          eligible.push(account);
        }
      }
    }

    return eligible.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  }

  checkEligibility(account, params) {
    const { eligibility } = account;
    if (!eligibility) return false;

    // Check pickup zone/keywords
    if (eligibility.pickup_zones || eligibility.pickup_keywords || eligibility.pickup_location_ids) {
      const pickupMatches = this.matchesLocation(
        params.pickup_address,
        params.pickup_location_id,
        eligibility.pickup_zones,
        eligibility.pickup_keywords,
        eligibility.pickup_location_ids
      );
      if (!pickupMatches) return false;
    }

    // Check destination zone/keywords
    if (eligibility.destination_zones || eligibility.destination_keywords || eligibility.destination_location_ids) {
      const destMatches = this.matchesLocation(
        params.destination_address,
        params.destination_location_id,
        eligibility.destination_zones,
        eligibility.destination_keywords,
        eligibility.destination_location_ids
      );
      if (!destMatches) return false;
    }

    // Check time windows
    if (eligibility.time_windows && params.pickup_time) {
      const timeOk = this.checkTimeWindow(
        params.pickup_time,
        params.destination_location_id || params.destination_address,
        eligibility.time_windows
      );
      if (!timeOk) return false;
    }

    // Check special conditions
    if (eligibility.must_cross_highway_82) {
      if (!this.checkCrossesHighway82(params)) return false;
    }

    if (eligibility.ase_transfers_only) {
      const toAirport = this.isAirport(params.destination_location_id, params.destination_address);
      if (!toAirport) return false;
    }

    return true;
  }

  matchesLocation(address, location_id, zones, keywords, location_ids) {
    if (location_id) {
      if (location_ids && location_ids.includes(location_id)) return true;
      if (zones && zones.includes(location_id)) return true;
    }

    if (keywords && address) {
      const lowerAddress = address.toLowerCase();
      if (keywords.some(kw => lowerAddress.includes(kw.toLowerCase()))) {
        return true;
      }
    }

    if (!zones && !keywords && !location_ids) return true;

    return false;
  }

  checkTimeWindow(pickup_time, destination_identifier, time_windows) {
    let window = time_windows.default;
    
    if (destination_identifier) {
      for (const [key, value] of Object.entries(time_windows)) {
        if (key !== 'default' && destination_identifier.toLowerCase().includes(key.toLowerCase())) {
          window = value;
          break;
        }
      }
    }

    if (!window) return true;

    const time = this.parseTime(pickup_time);
    if (!time) return true;

    const start = this.parseTime(window.start);
    const end = this.parseTime(window.end);
    if (!start || !end) return true;

    if (end === '00:00') {
      return time >= start;
    }

    return time >= start && time <= end;
  }

  checkCrossesHighway82(params) {
    const aciLat = 39.2150;
    const aspenCoreLat = 39.1911;
    
    if (!params.pickup_lat || !params.destination_lat) return false;
    
    return (
      (params.pickup_lat > aciLat && params.destination_lat < aspenCoreLat) ||
      (params.pickup_lat < aspenCoreLat && params.destination_lat > aciLat)
    );
  }

  isAirport(location_id, address) {
    const airportKeywords = ['ase-airport', 'airport', 'ase', 'aspen airport', 'pitkin', 'atlantic aviation'];
    
    if (location_id && airportKeywords.some(kw => location_id.toLowerCase().includes(kw))) {
      return true;
    }
    if (address && airportKeywords.some(kw => address.toLowerCase().includes(kw))) {
      return true;
    }
    return false;
  }

  findByHint(hint) {
    const lowerHint = hint.toLowerCase();
    
    return this.accounts.find(account => {
      if (account.id === hint) return true;
      if (account.name.toLowerCase().includes(lowerHint)) return true;
      
      const elig = account.eligibility;
      if (elig?.keywords?.some(kw => kw.toLowerCase().includes(lowerHint))) return true;
      if (elig?.pickup_keywords?.some(kw => kw.toLowerCase().includes(lowerHint))) return true;
      
      return false;
    }) || null;
  }

  findById(id) {
    return this.accounts.find(a => a.id === id) || null;
  }

  getByTriggerType(triggerType) {
    return this.accounts.filter(a => a.trigger_type === triggerType);
  }

  getDefault() {
    return {
      ok: true,
      eligible: false,
      account_id: null,
      account_name: "Regular Metered",
      account_type: "REGULAR_METERED",
      claire_script: null,
      instructions_note: "",
      skip_fare_quote: false
    };
  }

  parseTime(timeString) {
    if (!timeString) return null;
    
    if (timeString.toLowerCase() === 'now') {
      const now = new Date();
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
    
    const match = timeString.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      return `${match[1].padStart(2, '0')}:${match[2]}`;
    }
    
    const hourMatch = timeString.match(/(\d{1,2})\s*(am|pm)?/i);
    if (hourMatch) {
      let hour = parseInt(hourMatch[1]);
      const meridiem = hourMatch[2]?.toLowerCase();
      
      if (meridiem === 'pm' && hour < 12) hour += 12;
      if (meridiem === 'am' && hour === 12) hour = 0;
      
      return `${String(hour).padStart(2, '0')}:00`;
    }
    
    return null;
  }

  formatResponse(account, params = {}) {
    if (!account || account.type === 'REGULAR_METERED') {
      return this.getDefault();
    }

    let instructions = account.instructions_template || '';
    if (params.passenger_count && instructions.includes('{{passenger_count}}')) {
      instructions = instructions.replace(/\{\{passenger_count\}\}/g, params.passenger_count);
    }

    const claireScript = account.scripts?.claire_confirmation || 
                         account.scripts?.claire_if_yes ||
                         null;

    return {
      ok: true,
      eligible: true,
      account_id: account.id,
      account_name: account.name,
      account_type: account.type,
      claire_script: claireScript,
      instructions_note: instructions,
      skip_fare_quote: account.skip_fare_quote || false,
      passenger_payment: account.passenger_payment || null,
      restrictions: account.restrictions || {},
      billing: account.billing || null,
      requires_voucher: account.requires_voucher || false,
      scripts: account.scripts || {}
    };
  }
}

// ============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// ============================================================================

// Singleton instance
let _registryInstance = null;

/**
 * Load and return singleton AccountRegistry instance
 * This is what account-eligibility.js imports
 */
export function loadAccountRegistry() {
  if (!_registryInstance) {
    _registryInstance = new AccountRegistry(accountsData);
  }
  return _registryInstance;
}

/**
 * Get account registry (alias for loadAccountRegistry)
 */
export function getAccountRegistry() {
  return loadAccountRegistry();
}

/**
 * Check eligibility directly (convenience function)
 */
export function checkAccountEligibility(params) {
  const registry = loadAccountRegistry();
  const eligible = registry.findEligible(params);
  
  if (eligible.length === 0) {
    return registry.getDefault();
  }
  
  return registry.formatResponse(eligible[0], params);
}

// Default export is the class
export default AccountRegistry;