/**
 * Account Registry - Master class for account management
 * Loads accounts-registry.json and provides query methods
 */

export class AccountRegistry {
  constructor(registryData) {
    this.accounts = registryData.accounts || [];
    this.version = registryData.version;
    this.description = registryData.description;
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

    // ALWAYS check geo-triggered accounts (automatic)
    const geoAccounts = this.accounts.filter(a => a.trigger_type === 'geo_automatic');
    for (const account of geoAccounts) {
      if (this.checkEligibility(account, params)) {
        eligible.push(account);
      }
    }

    // Check hint-triggered accounts (if Claire provides hints)
    if (account_hints.length > 0) {
      for (const hint of account_hints) {
        const account = this.findByHint(hint);
        if (account && !eligible.includes(account)) {
          if (this.checkEligibility(account, params)) {
            eligible.push(account);
          }
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
    
    if (!eligibility) return false;

    // Check pickup zone/keywords
    if (eligibility.pickup_zones || eligibility.pickup_keywords) {
      const pickupMatches = this.matchesZone(
        params.pickup_address,
        params.pickup_location_id,
        eligibility.pickup_zones,
        eligibility.pickup_keywords
      );
      if (!pickupMatches) return false;
    }

    // Check destination zone/keywords
    if (eligibility.destination_zones || eligibility.destination_keywords) {
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

    if (eligibility.requires_exact_address && !params.customer_context?.has_exact_address) {
      // Will need to ask customer for exact address
      return true; // Still eligible, just needs more info
    }

    return true;
  }

  /**
   * Check if location matches zone
   */
  matchesZone(address, location_id, zones, keywords) {
    // Check location_id match
    if (location_id && zones) {
      if (zones.includes(location_id)) {
        return true;
      }
    }

    // Check keyword match
    if (keywords && address) {
      const lowerAddress = address.toLowerCase();
      return keywords.some(kw => lowerAddress.includes(kw.toLowerCase()));
    }

    // If no zones or keywords specified, consider it a match
    if (!zones && !keywords) {
      return true;
    }

    return false;
  }

  /**
   * Check if pickup time falls within allowed window
   */
  checkTimeWindow(pickup_time, destination_identifier, time_windows) {
    // Get time window for destination (or default)
    let window = time_windows.default;
    
    // Try to find specific window for destination
    if (destination_identifier) {
      for (const [key, value] of Object.entries(time_windows)) {
        if (key !== 'default' && destination_identifier.toLowerCase().includes(key.toLowerCase())) {
          window = value;
          break;
        }
      }
    }

    if (!window) return true; // No restriction

    // Parse time
    const time = this.parseTime(pickup_time);
    if (!time) return true; // Can't parse, allow

    const start = this.parseTime(window.start);
    const end = this.parseTime(window.end);

    if (!start || !end) return true;

    // Handle midnight crossing (e.g., 08:00 to 00:00 means 8am to midnight)
    if (end === '00:00') {
      // Allowed from start to end of day
      return time >= start;
    }

    // Normal time range
    return time >= start && time <= end;
  }

  /**
   * Check if route crosses Highway 82
   */
  checkCrossesHighway82(params) {
    const aciLat = 39.2150;  // Aspen Country Inn latitude
    const aspenCoreLat = 39.1911; // Aspen core latitude
    
    // Check if pickup and destination are on opposite sides
    return (
      (params.pickup_lat > aciLat && params.destination_lat < aspenCoreLat) ||
      (params.pickup_lat < aspenCoreLat && params.destination_lat > aciLat)
    );
  }

  /**
   * Check if location is airport
   */
  isAirport(location_id, address) {
    if (!location_id && !address) return false;
    
    const airportKeywords = ['ase-airport', 'airport', 'ase', 'aspen airport'];
    
    if (location_id) {
      return airportKeywords.some(kw => location_id.toLowerCase().includes(kw));
    }
    
    if (address) {
      return airportKeywords.some(kw => address.toLowerCase().includes(kw));
    }
    
    return false;
  }

  /**
   * Find account by hint keyword
   */
  findByHint(hint) {
    const lowerHint = hint.toLowerCase();
    
    return this.accounts.find(account => {
      // Check account ID
      if (account.id === hint) return true;
      
      // Check account name
      if (account.name.toLowerCase().includes(lowerHint)) return true;
      
      // Check eligibility keywords
      if (account.eligibility?.keywords) {
        return account.eligibility.keywords.some(kw => 
          kw.toLowerCase().includes(lowerHint) || lowerHint.includes(kw.toLowerCase())
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
   * Get all accounts by trigger type
   */
  getByTriggerType(triggerType) {
    return this.accounts.filter(a => a.trigger_type === triggerType);
  }

  /**
   * Get default regular metered account
   */
  getDefault() {
    return {
      id: null,
      name: "Regular Metered",
      type: "REGULAR_METERED",
      scripts: {
        claire_confirmation: null
      },
      skip_fare_quote: false,
      instructions_template: ""
    };
  }

  /**
   * Simple time parser (HH:MM format)
   */
  parseTime(timeString) {
    if (!timeString) return null;
    
    // Handle "now"
    if (timeString.toLowerCase() === 'now') {
      const now = new Date();
      return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
    
    // Extract HH:MM from various formats
    const match = timeString.match(/(\d{1,2}):(\d{2})/);
    if (match) {
      return `${match[1].padStart(2, '0')}:${match[2]}`;
    }
    
    // Try to extract just hour (e.g., "3pm", "15")
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

  /**
   * Format account for API response
   */
  formatResponse(account, params) {
    if (!account || account.type === 'REGULAR_METERED') {
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

    // Build instructions from template
    let instructions = account.instructions_template || '';
    
    // Replace template variables
    if (params.passenger_count && instructions.includes('{{passenger_count}}')) {
      instructions = instructions.replace(/\{\{passenger_count\}\}/g, params.passenger_count);
    }

    // Get appropriate claire_script
    let claireScript = account.scripts?.claire_confirmation;
    
    // Handle special cases
    if (account.special_rules?.never_mention_cost) {
      claireScript = account.scripts?.claire_confirmation;
    }

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
      special_rules: account.special_rules || {},
      billing: account.billing || null,
      
      // Additional scripts for context
      scripts: {
        customer_asks_about: account.scripts?.customer_asks_about,
        not_eligible_destination: account.scripts?.not_eligible_destination,
        not_eligible_time: account.scripts?.not_eligible_time,
        not_eligible_reason: account.scripts?.not_eligible_reason
      }
    };
  }
}

/**
 * Load registry from JSON file or object
 */
export async function loadAccountRegistry(source) {
  try {
    let data;
    
    if (typeof source === 'string') {
      // Load from file path
      const fs = await import('fs');
      const fileContent = fs.readFileSync(source, 'utf8');
      data = JSON.parse(fileContent);
    } else if (typeof source === 'object') {
      // Already loaded object
      data = source;
    } else {
      throw new Error('Invalid registry source');
    }
    
    return new AccountRegistry(data);
  } catch (error) {
    console.error('[registry] Failed to load:', error);
    throw new Error('Failed to load account registry: ' + error.message);
  }
}

/**
 * Validate registry structure
 */
export function validateRegistry(registryData) {
  const errors = [];
  
  if (!registryData.accounts || !Array.isArray(registryData.accounts)) {
    errors.push('Registry must have accounts array');
  }
  
  registryData.accounts?.forEach((account, index) => {
    if (!account.id) errors.push(`Account ${index} missing id`);
    if (!account.name) errors.push(`Account ${index} missing name`);
    if (!account.type) errors.push(`Account ${index} missing type`);
    if (!account.trigger_type) errors.push(`Account ${index} missing trigger_type`);
  });
  
  return {
    valid: errors.length === 0,
    errors
  };
}