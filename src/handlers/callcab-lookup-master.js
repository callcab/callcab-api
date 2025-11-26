// src/handlers/callcab-lookup-master.js
// CLAIRE v4.2 - FIXED Unified Lookup Master
// Fixes: Phone extraction, memory lookup, 3-conversation history

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',  
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Master lookup handler - called FIRST in every Claire conversation
 * Returns unified response with memory, iCabbi data, and pre-generated greeting
 */
export async function handleCallcabLookupMaster(request, env) {
  const startTime = Date.now();
  
  try {
    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return jsonResponse({ 
        ok: false, 
        error: 'METHOD_NOT_ALLOWED',
        message: 'Only POST requests allowed'
      }, 405);
    }

    const body = await request.json();

    // ========================================================================
    // CRITICAL FIX #1: Comprehensive Phone Extraction (like original /retrieve)
    // ========================================================================
    const customerPhone = extractPhone(body, request);
    
    if (!customerPhone) {
      console.error('[LookupMaster] MISSING_PHONE - tried all sources');
      return jsonResponse({
        ok: false,
        error: 'MISSING_PHONE',
        message: 'Phone number is required',
        hint: 'Include phone in: body.phone, customer.number, call.customer.number, or headers',
        sources_checked: [
          'body.phone', 'body.phone_backup', 'body.phone_emergency',
          'body.properties.phone', 'body.message.phone',
          'body.call.customer.number', 'body.customer.number',
          'headers: x-vapi-customer-number, x-customer-number, x-caller-number, phone'
        ]
      }, 400);
    }

    // Normalize to E.164
    const normalizedPhone = normalizePhone(customerPhone);
    if (!normalizedPhone) {
      return jsonResponse({
        ok: false,
        error: 'INVALID_PHONE', 
        message: 'Invalid phone number format',
        provided: customerPhone
      }, 400);
    }

    console.log(`[LookupMaster] Processing: ${normalizedPhone} (from: ${customerPhone})`);

    // Check required environment variables
    const missingEnvVars = checkRequiredEnvVars(env);
    if (missingEnvVars.length > 0) {
      console.error('[LookupMaster] Missing environment variables:', missingEnvVars);
    }

    // ========================================================================
    // CRITICAL FIX #2: Try Multiple Phone Formats for Memory Lookup
    // ========================================================================
    const phoneFormats = generatePhoneFormats(normalizedPhone);
    console.log('[LookupMaster] Will try phone formats for memory:', phoneFormats);

    // Parallel data fetching
    const [memoryData, icabbiData] = await Promise.allSettled([
      fetchMemoryDataWithFallbacks(phoneFormats, env),
      fetchIcabbiData(normalizedPhone, body.name, env)
    ]);

    // Process memory data
    let memory = null;
    let customer_data = { is_new_customer: true };

    if (memoryData.status === 'fulfilled' && memoryData.value) {
      memory = memoryData.value;
      console.log('[LookupMaster] Memory found:', {
        has_aggregated: !!memory.aggregated_context,
        preferred_name: memory.aggregated_context?.preferred_name,
        preferred_language: memory.aggregated_context?.preferred_language,
        history_count: memory.history_count
      });
    } else {
      console.warn('[LookupMaster] No memory found');
    }

    // Process iCabbi data  
    let icabbi = { found: false, hasActiveTrips: false };
    if (icabbiData.status === 'fulfilled' && icabbiData.value) {
      icabbi = icabbiData.value;
      console.log('[LookupMaster] iCabbi found:', {
        user_id: icabbi.user?.id,
        first_name: icabbi.user?.first_name,
        hasActiveTrips: icabbi.hasActiveTrips
      });
    } else {
      console.warn('[LookupMaster] iCabbi lookup failed:', icabbiData.reason);
    }

    // ========================================================================
    // CRITICAL FIX #3: Proper Priority - Memory > iCabbi (like original)
    // ========================================================================
    customer_data = processCustomerData(memory, icabbi, normalizedPhone);

    // Generate greeting and system context
    const systemContext = generateGreeting(memory, icabbi, customer_data);

    // Build unified response
    const response = {
      ok: true,
      timestamp: new Date().toISOString(),
      processing_time_ms: Date.now() - startTime,
      
      // Phone that was found (CRITICAL for downstream)
      phone: normalizedPhone,
      
      // Customer data (prioritizes memory over iCabbi)
      customer: customer_data,
      
      // Memory context
      memory: {
        has_memory: !!memory,
        last_3_summaries: memory?.last_3_summaries || [],
        hours_since_last_call: memory?.hours_since_last_call || null,
        behavior_flags: memory?.behavior || 'unknown',
        priority_notes: memory?.operational_notes || null,
        last_dropoff: memory?.last_dropoff || null,
        last_dropoff_coords: {
          lat: memory?.last_dropoff_lat || null,
          lng: memory?.last_dropoff_lng || null
        },
        last_trip_id: memory?.last_trip_id || null,
        conversation_state: memory?.conversation_state || null,
        was_dropped: memory?.was_dropped || false,
        collected_info: memory?.collected_info || null
      },
      
      // iCabbi data
      icabbi: {
        found: icabbi.found,
        customer_id: icabbi.user?.id || null,
        hasActiveTrips: icabbi.hasActiveTrips,
        active_trips: icabbi.activeTrips || [],
        nextTrip: icabbi.nextTrip || null,
        primary_address: icabbi.primaryAddress || null,
        user: icabbi.user ? {
          id: icabbi.user.id,
          name: icabbi.user.name,
          first_name: icabbi.user.first_name,
          last_name: icabbi.user.last_name,
          phone: icabbi.user.phone,
          vip: icabbi.user.vip
        } : null
      },
      
      // System context for greeting
      system: {
        greeting_text: systemContext.greeting_text,
        greeting_language: systemContext.greeting_language,
        scenario: systemContext.scenario,
        situational_context: systemContext.situational_context,
        name_used: systemContext.name_used
      }
    };

    console.log('[LookupMaster] Success:', {
      phone: normalizedPhone,
      scenario: systemContext.scenario,
      name_used: systemContext.name_used,
      has_memory: !!memory,
      icabbi_found: icabbi.found,
      processing_time_ms: response.processing_time_ms
    });

    return jsonResponse(response);

  } catch (error) {
    console.error('[LookupMaster] Error:', error);
    return jsonResponse({ 
      ok: false, 
      error: 'LOOKUP_FAILED',
      message: error.message
    }, 500);
  }
}

// ============================================================================
// PHONE EXTRACTION - COMPREHENSIVE (matches original /retrieve)
// ============================================================================

/**
 * Extract phone from ALL possible sources - matches working /retrieve endpoint
 */
function extractPhone(body, request) {
  // Priority order matches original working implementation
  const sources = [
    // Direct body properties (Vapi tool call format)
    body.phone,
    body.phone_backup,        // {{caller.phoneNumber}} backup
    body.phone_emergency,     // {{call.from}} fallback
    
    // Nested properties (various Vapi formats)
    body.properties?.phone,
    body.message?.phone,
    body.call?.customer?.number,
    body.customer?.number,
    body.customer?.phone,
    
    // Headers (webhook format)
    request.headers.get('x-vapi-customer-number'),
    request.headers.get('x-customer-number'),
    request.headers.get('x-caller-number'),
    request.headers.get('phone'),
  ];

  // Find first valid phone
  for (const source of sources) {
    if (source && String(source).trim().length >= 7) {
      const cleaned = String(source).replace(/\D/g, '');
      if (cleaned.length >= 7) {
        console.log('[extractPhone] Found phone from source:', source);
        return source;
      }
    }
  }

  return null;
}

/**
 * Generate multiple phone formats for KV lookup fallbacks
 */
function generatePhoneFormats(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const last10 = digits.slice(-10);
  
  return [
    `+1${last10}`,           // E.164: +13035551234
    `+${digits}`,            // With + prefix
    `001${last10}`,          // iCabbi format: 0013035551234
    last10,                  // Raw 10 digits: 3035551234
    `1${last10}`,            // With country code no +: 13035551234
    phone                    // Original format
  ].filter((v, i, a) => v && a.indexOf(v) === i); // Dedupe
}

// ============================================================================
// MEMORY FETCH - WITH FALLBACKS (like original)
// ============================================================================

/**
 * Fetch memory trying multiple phone formats
 */
async function fetchMemoryDataWithFallbacks(phoneFormats, env) {
  if (!env.CALL_MEMORIES) {
    console.warn('[Memory] CALL_MEMORIES KV not available');
    return null;
  }

  // Try each phone format until we find memory
  for (const phone of phoneFormats) {
    console.log(`[Memory] Trying format: ${phone}`);
    
    const latestKey = `latest:${phone}`;
    const latestData = await env.CALL_MEMORIES.get(latestKey);
    
    if (latestData) {
      console.log(`[Memory] Found with format: ${phone}`);
      const latest = JSON.parse(latestData);
      
      // Also fetch history for comprehensive summaries
      const historyKey = `history:${phone}`;
      const historyData = await env.CALL_MEMORIES.get(historyKey);
      const history = historyData ? JSON.parse(historyData) : [latest];
      
      // Calculate hours since last call
      const hours_since_last_call = calculateHoursSinceLastCall(latest.timestamp);
      
      // Build last 3 summaries from history
      const last_3_summaries = buildLast3Summaries(history);
      
      return {
        // From latest
        timestamp: latest.timestamp,
        outcome: latest.outcome,
        behavior: latest.behavior || 'unknown',
        conversation_state: latest.conversation_state,
        last_pickup: latest.last_pickup,
        last_dropoff: latest.last_dropoff,
        last_dropoff_lat: latest.last_dropoff_lat,
        last_dropoff_lng: latest.last_dropoff_lng,
        last_trip_id: latest.last_trip_id,
        was_dropped: latest.was_dropped || latest.outcome === 'dropped_call',
        operational_notes: latest.operational_notes,
        special_instructions: latest.special_instructions,
        collected_info: latest.collected_info,
        
        // Aggregated from history (CRITICAL for preferred_name)
        aggregated_context: latest.aggregated_context || buildAggregatedContext(history),
        
        // Computed
        hours_since_last_call,
        last_3_summaries,
        history_count: history.length,
        
        // Personal context
        personal_details: latest.personal_details,
        conversation_topics: latest.conversation_topics || [],
        jokes_shared: latest.jokes_shared,
        relationship_context: latest.relationship_context,
        trip_discussion: latest.trip_discussion
      };
    }
  }

  console.log('[Memory] No memory found with any format');
  return null;
}

/**
 * Build aggregated context from history (last 3-5 conversations)
 * This is the KEY function for preferred_name priority
 */
function buildAggregatedContext(history) {
  if (!history || history.length === 0) return {};
  
  // Take last 5 most recent calls
  const recentCalls = history.slice(0, 5);
  
  // PRIORITY: Most recent preferred_name wins
  let preferred_name = null;
  for (const call of recentCalls) {
    if (call.preferred_name) {
      preferred_name = call.preferred_name;
      console.log('[Aggregated] Found preferred_name in recent call:', preferred_name);
      break; // Stop at first (most recent) found
    }
  }
  
  // PRIORITY: Most recent non-English language
  let preferred_language = null;
  for (const call of recentCalls) {
    if (call.preferred_language && call.preferred_language !== 'english') {
      preferred_language = call.preferred_language;
      break;
    }
  }
  
  // PRIORITY: Most recent preferred pickup address
  let preferred_pickup_address = null;
  for (const call of recentCalls) {
    if (call.preferred_pickup_address) {
      preferred_pickup_address = call.preferred_pickup_address;
      break;
    }
  }
  
  // If no explicit preferred_pickup, check for pattern (2+ same location)
  if (!preferred_pickup_address) {
    const addressCounts = {};
    for (const call of history) {
      const addr = call.last_pickup || call.collected_info?.pickup_address;
      if (addr) {
        const normalized = addr.trim();
        addressCounts[normalized] = (addressCounts[normalized] || 0) + 1;
      }
    }
    
    // Find most used (if 2+ times)
    let maxCount = 0;
    for (const [addr, count] of Object.entries(addressCounts)) {
      if (count >= 2 && count > maxCount) {
        maxCount = count;
        preferred_pickup_address = addr;
      }
    }
  }
  
  // Collect all topics from recent calls
  const all_topics = new Set();
  recentCalls.forEach(call => {
    if (call.conversation_topics && Array.isArray(call.conversation_topics)) {
      call.conversation_topics.forEach(t => all_topics.add(t));
    }
  });
  
  // Collect jokes
  const all_jokes = [];
  recentCalls.forEach(call => {
    if (call.jokes_shared) {
      if (Array.isArray(call.jokes_shared)) {
        all_jokes.push(...call.jokes_shared);
      } else {
        all_jokes.push(call.jokes_shared);
      }
    }
  });
  
  // Merge personal details (newer overwrites older)
  const merged_personal = {};
  [...recentCalls].reverse().forEach(call => {
    if (call.personal_details && typeof call.personal_details === 'object') {
      Object.assign(merged_personal, call.personal_details);
    }
  });
  
  // Get most recent trip discussion and relationship context
  const trip_discussion = recentCalls.find(c => c.trip_discussion)?.trip_discussion || null;
  const relationship_context = recentCalls.find(c => c.relationship_context)?.relationship_context || null;
  
  // Behavioral pattern
  const behaviors = recentCalls.map(c => c.behavior);
  const positive_count = behaviors.filter(b => ['polite', 'friendly', 'grateful'].includes(b)).length;
  const negative_count = behaviors.filter(b => ['rude', 'inappropriate', 'abusive', 'impatient'].includes(b)).length;
  
  return {
    preferred_name,
    preferred_language,
    preferred_pickup_address,
    conversation_topics: Array.from(all_topics),
    jokes_shared: all_jokes.slice(0, 3),
    personal_details: merged_personal,
    trip_discussion,
    relationship_context,
    behavioral_pattern: {
      positive_calls: positive_count,
      negative_calls: negative_count,
      total_recent: recentCalls.length
    }
  };
}

/**
 * Build last 3 call summaries
 */
function buildLast3Summaries(history) {
  if (!history || history.length === 0) return [];
  
  return history.slice(0, 3).map(call => {
    let summary = call.summary || call.outcome || 'call';
    
    if (call.last_pickup && call.last_dropoff) {
      summary = `${call.outcome}: ${call.last_pickup} → ${call.last_dropoff}`;
    }
    
    return {
      timestamp: call.timestamp,
      summary,
      outcome: call.outcome,
      behavior: call.behavior,
      was_dropped: call.was_dropped || false
    };
  });
}

// ============================================================================
// ICABBI FETCH
// ============================================================================

async function fetchIcabbiData(phone, name, env) {
  try {
    const baseUrl = (env.ICABBI_BASE_URL || 'https://api.icabbi.us/us2').replace(/\/+$/, '');
    const appKey = env.ICABBI_APP_KEY;
    const secret = env.ICABBI_SECRET || env.ICABBI_SECRET_KEY;

    if (!appKey || !secret) {
      console.warn('[iCabbi] Missing credentials');
      return { found: false, hasActiveTrips: false };
    }

    const basic = btoa(`${appKey}:${secret}`);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Basic ${basic}`
    };

    // Try multiple phone formats
    const phoneFormats = generatePhoneFormats(phone);
    
    let userData = null;
    let foundWithFormat = null;

    for (const phoneFormat of phoneFormats) {
      try {
        // Method 1: Header-based lookup
        let response = await fetch(`${baseUrl}/users/index`, {
          method: 'POST',
          headers: { ...headers, Phone: phoneFormat }
        });

        if (response.ok) {
          const data = await response.json();
          if (data?.body?.user) {
            userData = data.body.user;
            foundWithFormat = phoneFormat;
            console.log(`[iCabbi] Found with header: ${phoneFormat}`);
            break;
          }
        }

        // Method 2: Query parameter
        response = await fetch(`${baseUrl}/users/index?phone=${encodeURIComponent(phoneFormat)}`, {
          method: 'POST',
          headers
        });

        if (response.ok) {
          const data = await response.json();
          if (data?.body?.user) {
            userData = data.body.user;
            foundWithFormat = phoneFormat;
            console.log(`[iCabbi] Found with query: ${phoneFormat}`);
            break;
          }
        }
      } catch (err) {
        console.warn(`[iCabbi] Error with ${phoneFormat}:`, err.message);
      }
    }

    if (!userData) {
      return { found: false, hasActiveTrips: false };
    }

    if (userData.banned) {
      return { 
        found: true, 
        user: { id: userData.id, banned: true },
        hasActiveTrips: false,
        message: 'Banned user - contact office'
      };
    }

    // Fetch address history
    const addresses = await fetchAddressHistory(foundWithFormat || phone, baseUrl, headers);
    
    // Fetch active trips
    const trips = await fetchActiveTrips(foundWithFormat || phone, baseUrl, headers);

    return {
      found: true,
      user: {
        id: userData.id,
        ix: userData.ix,
        phone: userData.phone,
        name: userData.name || null,
        first_name: userData.first_name || null,
        last_name: userData.last_name || null,
        email: userData.email || null,
        vip: !!userData.vip
      },
      primaryAddress: addresses.primary,
      addresses: addresses.history,
      hasActiveTrips: trips.length > 0,
      activeTrips: trips,
      nextTrip: trips[0] || null
    };

  } catch (error) {
    console.error('[iCabbi] Fetch error:', error);
    return { found: false, hasActiveTrips: false, error: error.message };
  }
}

async function fetchAddressHistory(phone, baseUrl, headers) {
  try {
    const response = await fetch(
      `${baseUrl}/users/addresses?phone=${encodeURIComponent(phone)}&period=365&type=PICKUP`,
      { method: 'GET', headers }
    );

    if (response.ok) {
      const data = await response.json();
      const addresses = data?.body?.addresses || [];
      
      // Sort by usage count
      const sorted = [...addresses].sort((a, b) => (b.used || 0) - (a.used || 0));
      
      return {
        primary: sorted[0]?.formatted || null,
        history: sorted.slice(0, 5)
      };
    }
  } catch (err) {
    console.warn('[iCabbi] Address fetch error:', err.message);
  }
  
  return { primary: null, history: [] };
}

async function fetchActiveTrips(phone, baseUrl, headers) {
  try {
    const iddPhone = `001${phone.replace(/\D/g, '').slice(-10)}`;
    
    const response = await fetch(
      `${baseUrl}/bookings/upcoming?phone=${encodeURIComponent(iddPhone)}`,
      { method: 'GET', headers }
    );

    if (response.ok) {
      const data = await response.json();
      const bookings = data?.body?.bookings || [];
      
      const now = Date.now();
      const next24h = now + 24 * 60 * 60 * 1000;
      
      return bookings
        .filter(b => new Date(b.pickup_date).getTime() < next24h)
        .map(b => ({
          trip_id: b.trip_id,
          perma_id: b.perma_id,
          pickup_date: b.pickup_date,
          pickup_address: b.pickup_address,
          destination_address: b.destination_address,
          status: b.status,
          pickup_time_human: formatLocalText(b.pickup_date)
        }));
    }
  } catch (err) {
    console.warn('[iCabbi] Trips fetch error:', err.message);
  }
  
  return [];
}

// ============================================================================
// CUSTOMER DATA PROCESSING - PRIORITY: Memory > iCabbi
// ============================================================================

function processCustomerData(memory, icabbi, phone) {
  const customer = {
    phone: phone,
    is_new_customer: !memory && !icabbi?.found,
    icabbi_customer_id: icabbi?.user?.id || null
  };

  // ====================================================================
  // CRITICAL: Memory preferences ALWAYS override iCabbi
  // ====================================================================
  
  const aggregated = memory?.aggregated_context || {};
  
  // PREFERRED NAME: Memory first, then iCabbi
  if (aggregated.preferred_name) {
    customer.preferred_name = aggregated.preferred_name;
    customer.name_source = 'memory';
    console.log('[Customer] Using MEMORY preferred_name:', aggregated.preferred_name);
  } else if (icabbi?.user?.first_name) {
    customer.preferred_name = icabbi.user.first_name;
    customer.name_source = 'icabbi';
    console.log('[Customer] Using iCabbi first_name:', icabbi.user.first_name);
  } else if (icabbi?.user?.name) {
    customer.preferred_name = icabbi.user.name.split(' ')[0];
    customer.name_source = 'icabbi';
  }

  // PREFERRED LANGUAGE: Memory only (default English)
  if (aggregated.preferred_language && aggregated.preferred_language !== 'english') {
    customer.preferred_language = aggregated.preferred_language;
    console.log('[Customer] Using MEMORY language:', aggregated.preferred_language);
  } else {
    customer.preferred_language = 'english';
  }

  // PREFERRED PICKUP: Memory first, then iCabbi primary
  if (aggregated.preferred_pickup_address) {
    customer.preferred_pickup_address = aggregated.preferred_pickup_address;
    customer.address_source = 'memory';
    console.log('[Customer] Using MEMORY pickup:', aggregated.preferred_pickup_address);
  } else if (icabbi?.primaryAddress) {
    customer.preferred_pickup_address = icabbi.primaryAddress;
    customer.address_source = 'icabbi';
    console.log('[Customer] Using iCabbi primary:', icabbi.primaryAddress);
  }

  // Additional iCabbi data (for reference, not override)
  if (icabbi?.user) {
    customer.icabbi_name = icabbi.user.name;
    customer.icabbi_first_name = icabbi.user.first_name;
    customer.icabbi_last_name = icabbi.user.last_name;
    customer.vip_status = icabbi.user.vip || false;
  }

  return customer;
}

// ============================================================================
// GREETING GENERATION
// ============================================================================

function generateGreeting(memory, icabbi, customer) {
  const language = customer.preferred_language || 'english';
  const name = customer.preferred_name || null;
  
  // Determine scenario
  let scenario = 'new_customer';
  let contextData = {};

  // Check scenarios in priority order
  if (icabbi?.hasActiveTrips && icabbi?.nextTrip) {
    scenario = 'active_trip';
    contextData = {
      trip_time: icabbi.nextTrip.pickup_time_human || icabbi.nextTrip.pickup_date,
      pickup_address: icabbi.nextTrip.pickup_address,
      destination_address: icabbi.nextTrip.destination_address
    };
  } else if (memory?.outcome === 'booking_created' && memory?.last_dropoff && memory?.hours_since_last_call < 2) {
    scenario = 'callback';
    contextData = { last_dropoff: memory.last_dropoff };
  } else if (memory?.was_dropped && memory?.hours_since_last_call < 1) {
    scenario = 'dropped_call';
    contextData = {
      conversation_state: memory.conversation_state,
      collected_info: memory.collected_info
    };
  } else if (memory?.trip_discussion) {
    scenario = 'trip_discussion';
    contextData = { trip_discussion: memory.trip_discussion };
  } else if (customer.preferred_pickup_address) {
    scenario = 'preferred_address';
    contextData = { 
      preferred_address: typeof customer.preferred_pickup_address === 'object'
        ? customer.preferred_pickup_address.formatted || customer.preferred_pickup_address.name
        : customer.preferred_pickup_address
    };
  } else if (icabbi?.primaryAddress) {
    scenario = 'primary_address';
    contextData = {
      primary_address: typeof icabbi.primaryAddress === 'object'
        ? icabbi.primaryAddress.formatted || icabbi.primaryAddress.name
        : icabbi.primaryAddress
    };
  } else if (memory?.aggregated_context || icabbi?.found) {
    scenario = 'known_customer';
  }

  // Generate greeting text
  const greetingText = generateGreetingText(scenario, language, name, contextData);

  // Build situational context
  const situationalContext = generateSituationalContext(memory, icabbi);

  return {
    scenario,
    greeting_text: greetingText,
    greeting_language: language,
    context_data: contextData,
    situational_context: situationalContext,
    name_used: name
  };
}

function generateGreetingText(scenario, language, name, contextData) {
  const greetings = {
    english: {
      active_trip: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}your ride to ${contextData.destination_address || 'your destination'} is confirmed for ${contextData.trip_time || 'later'}. Need to change anything?`,
      callback: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}need another ride from where I dropped you off at ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}looks like we got disconnected. Where were we?`,
      trip_discussion: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}ready to book that ${contextData.trip_discussion}?`,
      preferred_address: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}${contextData.preferred_address} again?`,
      primary_address: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}${contextData.primary_address} again?`,
      known_customer: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}where can we pick you up?`,
      new_customer: `High Mountain Taxi, this is Claire. Where can we pick you up?`
    },
    spanish: {
      active_trip: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}tu viaje a ${contextData.destination_address || 'tu destino'} está confirmado para ${contextData.trip_time || 'más tarde'}. ¿Necesitas cambiar algo?`,
      callback: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿necesitas otro taxi desde donde te dejé en ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}parece que se cortó la llamada. ¿Dónde estábamos?`,
      trip_discussion: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿listo para reservar ese ${contextData.trip_discussion}?`,
      preferred_address: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿${contextData.preferred_address} otra vez?`,
      primary_address: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿${contextData.primary_address} otra vez?`,
      known_customer: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿dónde te recojo?`,
      new_customer: `High Mountain Taxi, habla Claire. ¿Dónde te recojo?`
    },
    portuguese: {
      active_trip: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}sua corrida está confirmada. Precisa mudar algo?`,
      callback: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}precisa de outro táxi de ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}a ligação caiu. Onde estávamos?`,
      trip_discussion: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}pronto para reservar?`,
      preferred_address: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}${contextData.preferred_address} de novo?`,
      primary_address: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}${contextData.primary_address} de novo?`,
      known_customer: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}onde te pego?`,
      new_customer: `High Mountain Taxi, é a Claire. Onde te pego?`
    },
    german: {
      active_trip: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}Ihre Fahrt ist bestätigt. Möchten Sie etwas ändern?`,
      callback: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}brauchen Sie ein weiteres Taxi von ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}die Verbindung wurde unterbrochen. Wo waren wir?`,
      trip_discussion: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}bereit zu buchen?`,
      preferred_address: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}${contextData.preferred_address} wieder?`,
      primary_address: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}${contextData.primary_address} wieder?`,
      known_customer: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}wo sollen wir Sie abholen?`,
      new_customer: `High Mountain Taxi, hier ist Claire. Wo sollen wir Sie abholen?`
    },
    french: {
      active_trip: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}votre course est confirmée. Besoin de changer quelque chose?`,
      callback: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}besoin d'un autre taxi depuis ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}on a été coupés. Où en étions-nous?`,
      trip_discussion: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}prêt à réserver?`,
      preferred_address: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}${contextData.preferred_address} encore?`,
      primary_address: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}${contextData.primary_address} encore?`,
      known_customer: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}où puis-je vous prendre?`,
      new_customer: `High Mountain Taxi, ici Claire. Où puis-je vous prendre?`
    }
  };

  const langGreetings = greetings[language] || greetings.english;
  return langGreetings[scenario] || langGreetings.new_customer;
}

function generateSituationalContext(memory, icabbi) {
  const context = {
    suggest_luggage_question: false,
    suggest_skis_question: false,
    suggest_mobility_question: false,
    callback_context: null,
    conversation_topics: memory?.conversation_topics || [],
    personal_context: memory?.personal_details || null
  };

  if (memory?.last_dropoff) {
    const lastDropoff = memory.last_dropoff.toLowerCase();
    
    if (lastDropoff.includes('airport')) {
      context.suggest_luggage_question = true;
    }
    
    if (['buttermilk', 'highlands', 'snowmass', 'ajax', 'aspen mountain'].some(k => lastDropoff.includes(k))) {
      context.suggest_skis_question = true;
    }
    
    if (['hospital', 'clinic', 'medical'].some(k => lastDropoff.includes(k))) {
      context.suggest_mobility_question = true;
    }
  }

  if (memory?.last_dropoff && memory?.hours_since_last_call < 2) {
    context.callback_context = {
      suggest_return_trip: true,
      last_dropoff_location: memory.last_dropoff,
      time_since_dropoff: memory.hours_since_last_call
    };
  }

  return context;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function normalizePhone(input) {
  if (!input) return null;
  
  let digits = String(input).replace(/\D/g, '');
  
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  if (String(input).startsWith('+')) {
    return input;
  }
  
  return digits.length >= 10 ? `+${digits}` : null;
}

function calculateHoursSinceLastCall(timestamp) {
  if (!timestamp) return null;
  const lastCall = new Date(timestamp);
  const now = new Date();
  return Math.round((now - lastCall) / (1000 * 60 * 60) * 10) / 10;
}

function formatLocalText(iso, tz = 'America/Denver') {
  if (!iso) return null;
  
  try {
    const date = new Date(iso);
    const now = new Date();
    
    const dateFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric'
    });
    
    const timeFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit'
    });
    
    const dateStr = dateFormatter.format(date);
    const timeStr = timeFormatter.format(date);
    
    // Check if today
    const todayStr = dateFormatter.format(now);
    if (dateStr === todayStr) {
      return `today at ${timeStr}`;
    }
    
    // Check if tomorrow
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = dateFormatter.format(tomorrow);
    if (dateStr === tomorrowStr) {
      return `tomorrow at ${timeStr}`;
    }
    
    return `${dateStr} at ${timeStr}`;
  } catch (err) {
    return iso;
  }
}

function checkRequiredEnvVars(env) {
  const required = ['ICABBI_BASE_URL', 'ICABBI_APP_KEY'];
  const secretVar = env.ICABBI_SECRET ? 'ICABBI_SECRET' : 'ICABBI_SECRET_KEY';
  if (!env.ICABBI_SECRET && !env.ICABBI_SECRET_KEY) {
    return ['ICABBI_SECRET or ICABBI_SECRET_KEY'];
  }
  return required.filter(v => !env[v]);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}