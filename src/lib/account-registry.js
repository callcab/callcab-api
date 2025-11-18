/**
 * Account Registry - Master class for account management
 * Loads accounts-registry.json and provides query methods
 */

export class AccountRegistry {
  constructor(registryData) {
    this.accounts = registryData.accounts || [];
    this.version = registryData.version;
  }

  /**
   * Find accounts eligible based on booking parameters
   * @param {Object} params - Booking details
   * @returns {Array} - Eligible accounts sorted by priority
   */
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
      account_hints = [],
      customer_context = {}
    } = params;

    let eligible = [];

    // Check geo-triggered accounts (always)
    const geoAccounts = this.accounts.filter(a => a.trigger_type === 'geo_automatic');
    for (const account of geoAccounts) {
      if (this.checkEligibility(account, params)) {
        eligible.push(account);
      }
    }

    // Check hint-triggered accounts (if provided)
    if (account_hints.length > 0) {
      for (const hint of account_hints) {
        const account = this.findByHint(hint);
        if (account && this.checkEligibility(account, params)) {
          eligible.push(account);
        }
      }
    }

    // Sort by priority (higher = more important)
    return eligible.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Check if single account is eligible
   */
  checkEligibility(account, params) {
    const { eligibility } = account;
    
    // Check pickup zone
    if (eligibility.pickup_zones) {
      const pickupMatches = this.matchesZone(
        params.pickup_address,
        params.pickup_location_id,
        eligibility.pickup_zones,
        eligibility.pickup_keywords
      );
      if (!pickupMatches) return false;
    }

    // Check destination zone
    if (eligibility.destination_zones) {
      const destMatches = this.matchesZone(
        params.destination_address,
        params.destination_location_id,
        eligibility.destination_zones,
        eligibility.destination_keywords
      );
      if (!destMatches) return false;
    }

    // Check time windows
    if (eligibility.time_windows && params.pickup_time) {
      const timeOk = this.checkTimeWindow(
        params.pickup_time,
        params.destination_location_id,
        eligibility.time_windows
      );
      if (!timeOk) return false;
    }

    // Check special conditions
    if (eligibility.must_cross_highway_82) {
      if (!this.checkCrossesHighway82(params)) return false;
    }

    if (eligibility.must_be_off_shuttle_route) {
      // Simplified - assume true for now
      // In production, check actual shuttle route
    }

    return true;
  }

  /**
   * Check if location matches zone
   */
  matchesZone(address, location_id, zones, keywords) {
    // Check location_id match
    if (location_id && zones.includes(location_id)) {
      return true;
    }

    // Check keyword match
    if (keywords && address) {
      const lowerAddress = address.toLowerCase();
      return keywords.some(kw => lowerAddress.includes(kw));
    }

    return false;
  }

  /**
   * Check if pickup time falls within allowed window
   */
  checkTimeWindow(pickup_time, destination_id, time_windows) {
    // Get time window for destination (or default)
    let window = time_windows.default;
    
    for (const [key, value] of Object.entries(time_windows)) {
      if (key !== 'default' && destination_id?.includes(key)) {
        window = value;
        break;
      }
    }

    if (!window) return true;

    // Parse time (simplified - in production use proper time library)
    const time = this.parseTime(pickup_time);
    const start = this.parseTime(window.start);
    const end = this.parseTime(window.end);

    if (end === '00:00') {
      // Midnight means end of day
      return time >= start || time <= '00:00';
    }

    return time >= start && time <= end;
  }

  /**
   * Check if route crosses Highway 82
   */
  checkCrossesHighway82(params) {
    const aciLat = 39.2150;
    const aspenCoreLat = 39.1911;
    
    return (
      (params.pickup_lat > aciLat && params.destination_lat < aspenCoreLat) ||
      (params.pickup_lat < aspenCoreLat && params.destination_lat > aciLat)
    );
  }

  /**
   * Find account by hint keyword
   */
  findByHint(hint) {
    const lowerHint = hint.toLowerCase();
    
    return this.accounts.find(account => {
      // Check account name
      if (account.name.toLowerCase().includes(lowerHint)) return true;
      
      // Check keywords
      if (account.eligibility.keywords) {
        return account.eligibility.keywords.some(kw => 
          kw.includes(lowerHint) || lowerHint.includes(kw)
        );
      }
      
      return false;
    });
  }

  /**
   * Find account by ID
   */
  findById(id) {
    return this.accounts.find(a => a.id === id);
  }

  /**
   * Get default regular metered account
   */
  getDefault() {
    return {
      id: null,
      name: "Regular Metered",
      type: "REGULAR_METERED",
      claire_script: null,
      skip_fare_quote: false
    };
  }

  /**
   * Simple time parser (HH:MM format)
   */
  parseTime(timeString) {
    if (!timeString) return null;
    if (timeString === 'now') return new Date().toTimeString().slice(0, 5);
    
    // Extract HH:MM from various formats
    const match = timeString.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      return `${match[1].padStart(2, '0')}:${match[2]}`;
    }
    
    return null;
  }

  /**
   * Format account for API response
   */
  formatResponse(account, params) {
    if (!account) {
      return this.getDefault();
    }

    // Build instructions from template
    let instructions = account.instructions_template || '';
    
    // Replace variables
    if (params.passenger_count) {
      instructions = instructions.replace(
        '{{passenger_count}}',
        params.passenger_count
      );
    }

    return {
      ok: true,
      eligible: account.type !== 'REGULAR_METERED',
      account_id: account.id,
      account_name: account.name,
      account_type: account.type,
      claire_script: account.scripts?.claire_confirmation || null,
      instructions_note: instructions,
      skip_fare_quote: account.skip_fare_quote || false,
      passenger_payment: account.passenger_payment || null,
      restrictions: account.restrictions || {},
      special_rules: account.special_rules || {}
    };
  }
}

/**
 * Load registry from JSON
 */
export async function loadAccountRegistry(jsonPath) {
  try {
    const data = await import(jsonPath);
    return new AccountRegistry(data.default || data);
  } catch (error) {
    console.error('[registry] Failed to load:', error);
    throw new Error('Failed to load account registry');
  }
}