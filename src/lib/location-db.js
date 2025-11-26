// location-db.js
// CLAIRE v4.2 - Cloudflare Workers Compatible
// Replace your existing location-db.js with this file

export class LocationDatabase {
  /**
   * @param {Object} locationsData - The parsed locations.json data
   */
  constructor(locationsData) {
    if (!locationsData) {
      throw new Error('[LocationDB] No locations data provided');
    }
    
    this.locations = locationsData.locations || [];
    this.indices = locationsData.indices || {};
    this.towns = locationsData.service_area?.towns || {};
    this.confusionGroups = locationsData.confusion_groups || [];
    
    console.log(`[LocationDB] Initialized: ${this.locations.length} locations, ${Object.keys(this.indices.by_phonetic || {}).length} phonetic variants`);
  }

  // Find location by ID
  findById(id) {
    return this.locations.find(loc => loc.id === id) || null;
  }

  // Search by query with phonetic/misspelling support
  search(query, options = {}) {
    const {
      caller_coords = null,
      max_results = 5,
      category_filter = null
    } = options;

    if (!query || query.trim().length === 0) {
      return [];
    }

    const normalizedQuery = query.toLowerCase().trim();
    const matches = [];

    // PRIORITY 1: Exact canonical name match (score: 1.0)
    for (const loc of this.locations) {
      if (loc.canonical_name.toLowerCase() === normalizedQuery) {
        matches.push({
          location: loc,
          score: 1.0,
          match_type: 'exact'
        });
      }
    }

    // PRIORITY 2: Phonetic variant match (score: 0.9)
    if (this.indices.by_phonetic) {
      const phoneticIds = this.indices.by_phonetic[normalizedQuery] || [];
      for (const id of phoneticIds) {
        const loc = this.findById(id);
        if (loc && !matches.find(m => m.location.id === id)) {
          matches.push({
            location: loc,
            score: 0.9,
            match_type: 'phonetic'
          });
        }
      }
    }

    // PRIORITY 3: Misspelling match (score: 0.85)
    if (this.indices.by_misspelling) {
      const misspellingIds = this.indices.by_misspelling[normalizedQuery] || [];
      for (const id of misspellingIds) {
        const loc = this.findById(id);
        if (loc && !matches.find(m => m.location.id === id)) {
          matches.push({
            location: loc,
            score: 0.85,
            match_type: 'misspelling'
          });
        }
      }
    }

    // PRIORITY 4: Partial match in canonical name (score: 0.7)
    for (const loc of this.locations) {
      if (matches.find(m => m.location.id === loc.id)) continue;
      
      if (loc.canonical_name.toLowerCase().includes(normalizedQuery) ||
          normalizedQuery.includes(loc.canonical_name.toLowerCase())) {
        matches.push({
          location: loc,
          score: 0.7,
          match_type: 'partial'
        });
      }
    }

    // PRIORITY 5: Search keywords match (score: 0.6)
    for (const loc of this.locations) {
      if (matches.find(m => m.location.id === loc.id)) continue;
      
      const keywords = loc.search_keywords || [];
      if (keywords.some(kw => 
        kw.toLowerCase().includes(normalizedQuery) ||
        normalizedQuery.includes(kw.toLowerCase())
      )) {
        matches.push({
          location: loc,
          score: 0.6,
          match_type: 'keyword'
        });
      }
    }

    // Filter by category if specified
    let filteredMatches = matches;
    if (category_filter) {
      filteredMatches = matches.filter(m => 
        m.location.category === category_filter
      );
    }

    // Sort by score, then by distance if caller coords provided
    filteredMatches.sort((a, b) => {
      if (a.score !== b.score) {
        return b.score - a.score;
      }
      
      if (caller_coords) {
        const distA = this.calculateDistance(
          caller_coords.lat, caller_coords.lng,
          a.location.coordinates.lat, a.location.coordinates.lng
        );
        const distB = this.calculateDistance(
          caller_coords.lat, caller_coords.lng,
          b.location.coordinates.lat, b.location.coordinates.lng
        );
        return distA - distB;
      }
      
      return 0;
    });

    return filteredMatches.slice(0, max_results);
  }

  // Calculate distance between two points (Haversine formula)
  calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3959; // Earth's radius in miles
    const dLat = this.toRad(lat2 - lat1);
    const dLon = this.toRad(lon2 - lon1);
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(this.toRad(lat1)) * Math.cos(this.toRad(lat2)) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  toRad(degrees) {
    return degrees * (Math.PI / 180);
  }

  // Detect caller's town based on coordinates
  detectCallerTown(lat, lng) {
    let closestTown = null;
    let minDistance = Infinity;

    for (const [townKey, townData] of Object.entries(this.towns)) {
      const distance = this.calculateDistance(
        lat, lng,
        townData.coordinates.lat,
        townData.coordinates.lng
      );

      if (distance < minDistance && distance < townData.radius_miles) {
        minDistance = distance;
        closestTown = {
          key: townKey,
          name: townData.display_name,
          distance_miles: Math.round(distance * 100) / 100
        };
      }
    }

    return closestTown;
  }

  // Get confusion group for a location (e.g., Clark's vs City Market)
  getConfusionGroup(locationId) {
    return this.confusionGroups.find(group => 
      group.members.includes(locationId)
    ) || null;
  }

  // Get locations by category
  getByCategory(category) {
    return this.locations.filter(loc => loc.category === category);
  }

  // Get locations by town
  getByTown(town) {
    if (this.indices.by_town && this.indices.by_town[town]) {
      return this.indices.by_town[town].map(id => this.findById(id)).filter(Boolean);
    }
    return this.locations.filter(loc => 
      loc.town === town || loc.address?.toLowerCase().includes(town.toLowerCase())
    );
  }

  // Get Claire's greeting phrase for a location
  getClaireGreeting(locationId) {
    const loc = this.findById(locationId);
    return loc?.claire_knows?.greeting_phrase || null;
  }

  // Check if location has account billing
  getAccountInfo(locationId) {
    const loc = this.findById(locationId);
    return loc?.account || null;
  }

  // Get location restrictions
  getRestrictions(locationId) {
    const loc = this.findById(locationId);
    return loc?.restrictions || null;
  }
}