import { LocationDatabase } from '../lib/location-db.js';
import { geocodeAddress } from '../lib/google-api.js';
import { jsonResponse } from '../lib/utils.js';

export async function handleValidateAddress(request, env) {
  try {
    const body = await request.json();
    const { query, caller_context = {} } = body;

    if (!query) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_QUERY',
        details: 'query parameter is required'
      }, 400);
    }

    const db = new LocationDatabase();
    
    // Detect caller's town if coords provided
    let callerTown = null;
    if (caller_context.last_pickup_coords) {
      callerTown = db.detectCallerTown(
        caller_context.last_pickup_coords.lat,
        caller_context.last_pickup_coords.lng
      );
    }

    // Search local database first
    const matches = db.search(query, {
      caller_coords: caller_context.last_pickup_coords,
      max_results: 5
    });

    if (matches.length > 0) {
      const bestMatch = matches[0];
      const location = bestMatch.location;

      // Check for disambiguation
      const needsDisambiguation = matches.length > 1 && 
        matches[1].score > 0.7;

      const response = {
        ok: true,
        is_valid: true,
        source: 'local_db',
        match_type: bestMatch.match_type,
        confidence: bestMatch.score,
        
        // Location details
        location_id: location.id,
        best_match_name: location.canonical_name,
        normalized_address: location.address,
        lat: location.coordinates.lat,
        lng: location.coordinates.lng,
        
        // Restrictions
        restrictions: location.restrictions || {},
        
        // Account info
        account_info: location.account || null,
        
        // HOA eligibility
        hoa_eligible: location.hoa_eligible || null,
        
        // Airport specific
        airport_specific: location.airport_specific || null,
        
        // Tour specific
        tour_specific: location.tour_specific || null,
        
        // Disambiguation
        disambiguation_needed: needsDisambiguation,
        alternative_matches: needsDisambiguation ? matches.slice(1, 3).map(m => ({
          name: m.location.canonical_name,
          address: m.location.address,
          distance_miles: callerTown ? db.calculateDistance(
            caller_context.last_pickup_coords.lat,
            caller_context.last_pickup_coords.lng,
            m.location.coordinates.lat,
            m.location.coordinates.lng
          ).toFixed(1) : null
        })) : [],
        
        // Claire script
        claire_script: location.claire_knows?.confirmation_phrase || null,
        destination_context: location.claire_knows?.destination_context || null,
        
        // Localization
        localized_from: callerTown?.name || null
      };

      // Check for confusion matrix
      const confusionGroup = db.getConfusionGroup(location.id);
      if (confusionGroup) {
        response.confusion_warning = confusionGroup.disambiguation_script;
      }

      return jsonResponse(response);
    }

    // Fallback to Google Maps API
    if (env.GOOGLE_MAPS_API_KEY) {
      const geocoded = await geocodeAddress(query + ', Colorado', env.GOOGLE_MAPS_API_KEY);
      
      if (geocoded) {
        return jsonResponse({
          ok: true,
          is_valid: true,
          source: 'google_maps',
          confidence: 0.6,
          
          best_match_name: query,
          normalized_address: geocoded.formatted_address,
          lat: geocoded.lat,
          lng: geocoded.lng,
          place_id: geocoded.place_id,
          
          restrictions: {
            allows_pickup: true,
            allows_dropoff: true,
            no_cell_signal: false
          },
          
          disambiguation_needed: false,
          claire_script: null
        });
      }
    }

    // No matches found
    return jsonResponse({
      ok: true,
      is_valid: false,
      matches: [],
      message: 'Could not find that location. Please try a nearby cross street or landmark.'
    });

  } catch (error) {
    console.error('[validate-address] Error:', error);
    return jsonResponse({
      ok: false,
      error: 'VALIDATION_FAILED',
      message: error.message
    }, 500);
  }
}