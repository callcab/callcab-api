// src/handlers/callcab-lookup-master.js
// FINAL PRODUCTION VERSION - Claire v4.1 Unified Lookup Master
// Returns: Memory + iCabbi + Greeting + Context in single call

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',  
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Rate limiting configuration
const RATE_LIMITS = {
  PER_PHONE_PER_MINUTE: 10,    // Max 10 calls per phone per minute
  PER_IP_PER_MINUTE: 30,       // Max 30 calls per IP per minute  
  PER_PHONE_PER_HOUR: 60,      // Max 60 calls per phone per hour
  GLOBAL_PER_MINUTE: 200       // Max 200 total calls per minute
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
    const { phone, name, customer } = body;

    // Extract phone from multiple possible locations
    const customerPhone = phone || customer?.number || customer?.phone;
    
    if (!customerPhone) {
      return jsonResponse({
        ok: false,
        error: 'MISSING_PHONE',
        message: 'Phone number is required',
        hint: 'Include phone in request body or customer.number field'
      }, 400);
    }

    const normalizedPhone = normalizePhone(customerPhone);
    if (!normalizedPhone) {
      return jsonResponse({
        ok: false,
        error: 'INVALID_PHONE', 
        message: 'Invalid phone number format',
        provided: customerPhone
      }, 400);
    }

    // Rate limiting check
    const clientIP = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
    const rateLimitResult = await checkRateLimit(normalizedPhone, clientIP, env);
    
    if (!rateLimitResult.allowed) {
      console.warn('[LookupMaster] Rate limit exceeded:', rateLimitResult.reason);
      return jsonResponse({
        ok: false,
        error: 'RATE_LIMITED',
        message: 'Too many requests. Please wait before calling again.',
        retry_after: rateLimitResult.retry_after || 60
      }, 429);
    }

    console.log(`[LookupMaster] Processing lookup for: ${normalizedPhone}, name: ${name || 'none'}, IP: ${clientIP}`);

    // Check required environment variables
    const missingEnvVars = checkRequiredEnvVars(env);
    if (missingEnvVars.length > 0) {
      console.error('[LookupMaster] Missing environment variables:', missingEnvVars);
      return jsonResponse({
        ok: false,
        error: 'CONFIGURATION_ERROR',
        message: 'Service configuration incomplete',
        missing_vars: missingEnvVars
      }, 500);
    }

    // Parallel data fetching for speed
    const [memoryData, icabbiData] = await Promise.allSettled([
      fetchMemoryData(normalizedPhone, env),
      fetchIcabbiData(normalizedPhone, name, env)
    ]);

    // Process memory data
    let memory = null;
    let customer_data = { is_new_customer: true };

    if (memoryData.status === 'fulfilled' && memoryData.value) {
      memory = memoryData.value;
      customer_data = processCustomerData(memory, icabbiData.status === 'fulfilled' ? icabbiData.value : null);
    } else {
      console.warn('[LookupMaster] Memory fetch failed:', memoryData.reason);
    }

    // Process iCabbi data  
    let icabbi = { found: false, hasActiveTrips: false };
    if (icabbiData.status === 'fulfilled' && icabbiData.value) {
      icabbi = icabbiData.value;
    } else {
      console.warn('[LookupMaster] iCabbi fetch failed:', icabbiData.reason);
    }

    // Generate greeting and system context
    const systemContext = generateGreeting(memory, icabbi, customer_data);

    // Build unified response
    const response = {
      ok: true,
      timestamp: new Date().toISOString(),
      processing_time_ms: Date.now() - startTime,
      
      // Customer data (prioritizes memory over iCabbi)
      customer: customer_data,
      
      // Memory context
      memory: {
        has_memory: !!memory,
        last_3_summaries: memory?.last_3_summaries || [],
        hours_since_last_call: memory ? calculateHoursSinceLastCall(memory.timestamp) : null,
        behavior_flags: memory?.behavior || 'unknown',
        priority_notes: memory?.operational_notes || null,
        last_dropoff: memory?.last_dropoff || null,
        last_trip_id: memory?.last_trip_id || null,
        conversation_state: memory?.conversation_state || null
      },
      
      // iCabbi data
      icabbi: {
        found: icabbi.found,
        customer_id: icabbi.user?.id || null,
        hasActiveTrips: icabbi.hasActiveTrips,
        active_trips: icabbi.activeTrips || [],
        nextTrip: icabbi.nextTrip || null,
        primary_address: icabbi.primaryAddress || null,
        user: icabbi.user || null
      },
      
      // System context (greeting, scenario, language)
      system: systemContext
    };

    // Update rate limit counters
    await updateRateLimit(normalizedPhone, clientIP, env);

    console.log(`[LookupMaster] ✅ Lookup completed: ${systemContext.scenario}, language: ${systemContext.greeting_language}, memory: ${!!memory}`);

    return jsonResponse(response);

  } catch (error) {
    console.error('[LookupMaster] Fatal error:', error);
    console.error('[LookupMaster] Stack:', error.stack);
    
    return jsonResponse({
      ok: false,
      error: 'INTERNAL_ERROR',
      message: 'Service temporarily unavailable',
      processing_time_ms: Date.now() - startTime,
      timestamp: new Date().toISOString()
    }, 500);
  }
}

/**
 * Rate limiting implementation using KV store
 */
async function checkRateLimit(phone, clientIP, env) {
  try {
    if (!env.CALL_MEMORIES) {
      return { allowed: true }; // No rate limiting if KV unavailable
    }

    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);

    // Check multiple rate limits
    const checks = [
      { key: `rate:phone:${phone}:${minute}`, limit: RATE_LIMITS.PER_PHONE_PER_MINUTE, window: 'minute' },
      { key: `rate:phone:${phone}:${hour}`, limit: RATE_LIMITS.PER_PHONE_PER_HOUR, window: 'hour' },
      { key: `rate:ip:${clientIP}:${minute}`, limit: RATE_LIMITS.PER_IP_PER_MINUTE, window: 'minute' },
      { key: `rate:global:${minute}`, limit: RATE_LIMITS.GLOBAL_PER_MINUTE, window: 'global' }
    ];

    for (const check of checks) {
      const current = await env.CALL_MEMORIES.get(check.key);
      const count = current ? parseInt(current) : 0;
      
      if (count >= check.limit) {
        return {
          allowed: false,
          reason: `${check.window} limit exceeded for ${check.window === 'global' ? 'system' : phone}`,
          retry_after: check.window === 'hour' ? 3600 : 60
        };
      }
    }

    return { allowed: true };
  } catch (error) {
    console.warn('[RateLimit] Check failed:', error);
    return { allowed: true }; // Allow on error
  }
}

/**
 * Update rate limit counters
 */
async function updateRateLimit(phone, clientIP, env) {
  try {
    if (!env.CALL_MEMORIES) return;

    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const hour = Math.floor(now / 3600000);

    const updates = [
      { key: `rate:phone:${phone}:${minute}`, ttl: 60 },
      { key: `rate:phone:${phone}:${hour}`, ttl: 3600 },
      { key: `rate:ip:${clientIP}:${minute}`, ttl: 60 },
      { key: `rate:global:${minute}`, ttl: 60 }
    ];

    for (const update of updates) {
      const current = await env.CALL_MEMORIES.get(update.key);
      const count = current ? parseInt(current) + 1 : 1;
      await env.CALL_MEMORIES.put(update.key, count.toString(), { expirationTtl: update.ttl });
    }
  } catch (error) {
    console.warn('[RateLimit] Update failed:', error);
  }
}

/**
 * Check required environment variables
 */
function checkRequiredEnvVars(env) {
  const required = ['ICABBI_BASE_URL', 'ICABBI_APP_KEY', 'ICABBI_SECRET'];
  return required.filter(varName => !env[varName]);
}

/**
 * Fetch memory data from KV store
 */
async function fetchMemoryData(phone, env) {
  try {
    if (!env.CALL_MEMORIES) {
      console.warn('[Memory] CALL_MEMORIES KV not available');
      return null;
    }

    const latestKey = `latest:${phone}`;
    const latestData = await env.CALL_MEMORIES.get(latestKey);
    
    if (!latestData) {
      console.log('[Memory] No memory found for:', phone);
      return null;
    }

    const memory = JSON.parse(latestData);
    console.log('[Memory] Retrieved for:', phone, {
      timestamp: memory.timestamp,
      has_aggregated: !!memory.aggregated_context,
      outcome: memory.outcome,
      behavior: memory.behavior
    });

    // Build comprehensive memory object
    return {
      timestamp: memory.timestamp,
      outcome: memory.outcome,
      behavior: memory.behavior || 'unknown',
      conversation_state: memory.conversation_state,
      last_pickup: memory.last_pickup,
      last_dropoff: memory.last_dropoff,
      last_dropoff_lat: memory.last_dropoff_lat,
      last_dropoff_lng: memory.last_dropoff_lng,
      last_trip_id: memory.last_trip_id,
      was_dropped: memory.was_dropped || memory.outcome === 'dropped_call',
      operational_notes: memory.operational_notes,
      special_instructions: memory.special_instructions,
      
      // Aggregated context (persistent preferences)
      aggregated_context: memory.aggregated_context || {},
      
      // Generate summaries (last 3 conversations)
      last_3_summaries: generateCallSummaries(memory),
      
      // Personal context
      personal_details: memory.personal_details,
      conversation_topics: memory.conversation_topics || [],
      jokes_shared: memory.jokes_shared,
      relationship_context: memory.relationship_context,
      trip_discussion: memory.trip_discussion
    };

  } catch (error) {
    console.error('[Memory] Fetch error:', error);
    return null;
  }
}

/**
 * Fetch iCabbi customer data with Basic Auth
 */
async function fetchIcabbiData(phone, name, env) {
  try {
    const baseUrl = env.ICABBI_BASE_URL;
    const appKey = env.ICABBI_APP_KEY;
    const secret = env.ICABBI_SECRET;

    if (!baseUrl || !appKey || !secret) {
      throw new Error('Missing iCabbi credentials');
    }

    // Basic Authentication (CRITICAL FIX)
    const basic = btoa(`${appKey}:${secret}`);
    const headers = {
      'Content-Type': 'application/json',
      'accept': 'application/json',
      'Authorization': `Basic ${basic}`
    };

    // Try multiple phone formats for better success rate
    const phoneFormats = [
      `001${phone.replace(/\D/g, '').slice(-10)}`, // iCabbi format: 0013105551234
      phone.startsWith('+') ? phone : `+${phone.replace(/\D/g, '')}`, // E164: +13105551234
      phone.replace(/\D/g, '').slice(-10), // Raw: 3105551234
      phone // Original format
    ];

    let userData = null;
    let foundWithFormat = null;

    // Try each phone format
    for (const phoneFormat of phoneFormats) {
      try {
        console.log(`[iCabbi] Trying phone format: ${phoneFormat}`);
        
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
            console.log(`[iCabbi] Found user with header method: ${phoneFormat}`);
            break;
          }
        }

        // Method 2: Query parameter fallback
        response = await fetch(`${baseUrl}/users/index?phone=${encodeURIComponent(phoneFormat)}`, {
          method: 'POST',
          headers
        });

        if (response.ok) {
          const data = await response.json();
          if (data?.body?.user) {
            userData = data.body.user;
            foundWithFormat = phoneFormat;
            console.log(`[iCabbi] Found user with query method: ${phoneFormat}`);
            break;
          }
        }
      } catch (error) {
        console.warn(`[iCabbi] Error with format ${phoneFormat}:`, error.message);
        continue;
      }
    }

    // If customer not found and name provided, try to create
    if (!userData && name && name.trim()) {
      console.log('[iCabbi] Customer not found, attempting to create:', name);
      userData = await createIcabbiCustomer(phone, name, env, headers, baseUrl);
    }

    if (!userData) {
      console.log('[iCabbi] Customer not found in iCabbi:', phone);
      return { found: false, hasActiveTrips: false };
    }

    // Get active trips for this customer
    const activeTrips = await getActiveTrips(foundWithFormat || phone, env, headers, baseUrl);
    
    // Get address history
    const addresses = await getAddressHistory(foundWithFormat || phone, env, headers, baseUrl);

    return {
      found: true,
      user: userData,
      hasActiveTrips: activeTrips.length > 0,
      activeTrips,
      nextTrip: activeTrips[0] || null, // Next upcoming trip
      primaryAddress: addresses.primary || null,
      addressHistory: addresses.history || [],
      found_with_format: foundWithFormat
    };

  } catch (error) {
    console.error('[iCabbi] Fetch error:', error);
    return { found: false, hasActiveTrips: false, error: error.message };
  }
}

/**
 * Create new customer in iCabbi if name provided
 */
async function createIcabbiCustomer(phone, name, env, headers, baseUrl) {
  try {
    const nameParts = name.split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.slice(1).join(' ') || '';

    const userData = {
      first_name: firstName,
      last_name: lastName,
      phone: phone.replace(/\D/g, '').slice(-10), // 10 digit format for creation
      email: `${firstName.toLowerCase()}@autocreated.com`, // Auto-generated email
      source: 'claire_ai_autocreate'
    };

    console.log('[iCabbi] Creating customer:', userData);

    const response = await fetch(`${baseUrl}/users/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(userData)
    });

    if (response.ok) {
      const result = await response.json();
      console.log('[iCabbi] Customer created successfully:', result.body?.user?.id);
      return result.body?.user || null;
    } else {
      console.warn('[iCabbi] Customer creation failed:', response.status, await response.text());
      return null;
    }
  } catch (error) {
    console.error('[iCabbi] Customer creation error:', error);
    return null;
  }
}

/**
 * Get active/upcoming trips for customer
 */
async function getActiveTrips(phone, env, headers, baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/bookings/upcoming`, {
      method: 'POST',
      headers: { ...headers, Phone: phone }
    });

    if (response.ok) {
      const data = await response.json();
      return data?.body?.bookings || [];
    }
    return [];
  } catch (error) {
    console.warn('[iCabbi] Active trips fetch error:', error);
    return [];
  }
}

/**
 * Get customer address history
 */
async function getAddressHistory(phone, env, headers, baseUrl) {
  try {
    // Get pickup addresses from last 365 days
    const response = await fetch(`${baseUrl}/users/addresses?phone=${encodeURIComponent(phone)}&period=365&type=PICKUP&limit=10`, {
      method: 'POST',
      headers
    });

    if (response.ok) {
      const data = await response.json();
      const addresses = data?.body?.addresses || [];
      
      return {
        primary: addresses.length > 0 ? addresses[0] : null,
        history: addresses
      };
    }
    return { primary: null, history: [] };
  } catch (error) {
    console.warn('[iCabbi] Address history fetch error:', error);
    return { primary: null, history: [] };
  }
}

/**
 * Process customer data with proper priority: Memory > iCabbi
 */
function processCustomerData(memory, icabbi) {
  // Start with base data
  const customer = {
    is_new_customer: !memory && !icabbi?.found,
    icabbi_customer_id: icabbi?.user?.id || null
  };

  // PRIORITY 1: Memory preferences (HIGHEST)
  const aggregated = memory?.aggregated_context || {};
  
  if (aggregated.preferred_name) {
    customer.preferred_name = aggregated.preferred_name;
    console.log('[Customer] Using memory preferred_name:', aggregated.preferred_name);
  } else if (icabbi?.user?.first_name) {
    customer.preferred_name = icabbi.user.first_name;
    console.log('[Customer] Using iCabbi first_name:', icabbi.user.first_name);
  } else if (icabbi?.user?.name) {
    customer.preferred_name = icabbi.user.name.split(' ')[0];
    console.log('[Customer] Using iCabbi name (first part):', customer.preferred_name);
  }

  if (aggregated.preferred_language) {
    customer.preferred_language = aggregated.preferred_language;
    console.log('[Customer] Using memory language:', aggregated.preferred_language);
  } else {
    customer.preferred_language = 'english'; // Default
  }

  if (aggregated.preferred_pickup_address) {
    customer.preferred_pickup_address = aggregated.preferred_pickup_address;
    console.log('[Customer] Using memory pickup address:', aggregated.preferred_pickup_address);
  } else if (icabbi?.primaryAddress) {
    customer.preferred_pickup_address = icabbi.primaryAddress;
    console.log('[Customer] Using iCabbi primary address:', icabbi.primaryAddress);
  }

  // PRIORITY 2: iCabbi data (only if no memory preference)
  if (icabbi?.user && !customer.preferred_name) {
    customer.icabbi_name = icabbi.user.name;
    customer.icabbi_first_name = icabbi.user.first_name;
    customer.icabbi_last_name = icabbi.user.last_name;
    customer.icabbi_email = icabbi.user.email;
  }

  if (icabbi?.primaryAddress && !customer.preferred_pickup_address) {
    customer.primary_address = icabbi.primaryAddress;
  }

  console.log('[Customer] Final customer data:', {
    preferred_name: customer.preferred_name,
    preferred_language: customer.preferred_language,
    preferred_pickup_address: customer.preferred_pickup_address,
    is_new_customer: customer.is_new_customer,
    has_icabbi: !!customer.icabbi_customer_id
  });

  return customer;
}

/**
 * Generate greeting with proper scenario detection
 */
function generateGreeting(memory, icabbi, customer) {
  const language = customer.preferred_language || 'english';
  const name = customer.preferred_name || null;
  
  // Determine scenario based on comprehensive context
  let scenario = 'new_customer';
  let contextData = {};

  if (icabbi?.hasActiveTrips && icabbi?.nextTrip) {
    scenario = 'active_trip';
    contextData = {
      trip_time: icabbi.nextTrip.pickup_time,
      pickup_address: icabbi.nextTrip.pickup_address,
      destination_address: icabbi.nextTrip.destination_address
    };
  } else if (memory?.last_dropoff && memory?.hours_since_last_call < 2) {
    scenario = 'callback';
    contextData = {
      last_dropoff: memory.last_dropoff,
      hours_ago: memory.hours_since_last_call
    };
  } else if (memory?.was_dropped || memory?.outcome === 'dropped_call') {
    scenario = 'dropped_call';
    contextData = {
      conversation_state: memory.conversation_state,
      last_pickup: memory.last_pickup,
      collected_info: memory.collected_info
    };
  } else if (memory?.trip_discussion) {
    scenario = 'trip_discussion';
    contextData = {
      trip_discussion: memory.trip_discussion
    };
  } else if (customer.preferred_pickup_address) {
    scenario = 'preferred_address';
    contextData = {
      preferred_address: customer.preferred_pickup_address
    };
  } else if (icabbi?.primaryAddress) {
    scenario = 'primary_address'; 
    contextData = {
      primary_address: icabbi.primaryAddress
    };
  } else if (memory?.aggregated_context || icabbi?.found) {
    scenario = 'known_customer';
  }

  // Generate greeting text in appropriate language
  const greeting = generateGreetingText(scenario, language, name, contextData);

  // Generate situational context for conversation
  const situationalContext = generateSituationalContext(memory, icabbi);

  return {
    scenario,
    greeting_text: greeting.text,
    greeting_language: language,
    context_data: contextData,
    situational_context: situationalContext,
    name_used: name,
    memory_driven: !!memory,
    icabbi_driven: !!icabbi?.found
  };
}

/**
 * Generate greeting text in multiple languages
 */
function generateGreetingText(scenario, language, name, contextData) {
  const greetings = {
    english: {
      active_trip: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}your ride to ${contextData.destination_address} is confirmed for ${contextData.trip_time}. Need to change anything?`,
      callback: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}need another ride from where I dropped you off at ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}looks like we got disconnected. Where were we?`,
      trip_discussion: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}ready to book that ${contextData.trip_discussion}?`,
      preferred_address: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}${contextData.preferred_address} again?`,
      primary_address: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}${contextData.primary_address} again?`,
      known_customer: `High Mountain Taxi, this is Claire. ${name ? `Hi ${name}, ` : ''}where can we pick you up?`,
      new_customer: `High Mountain Taxi, this is Claire. Where can we pick you up?`
    },
    spanish: {
      active_trip: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}tu viaje a ${contextData.destination_address} está confirmado para las ${contextData.trip_time}. ¿Necesitas cambiar algo?`,
      callback: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿necesitas otro taxi desde donde te dejé en ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}parece que se cortó la llamada. ¿Dónde estábamos?`,
      trip_discussion: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿listo para reservar ese ${contextData.trip_discussion}?`,
      preferred_address: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿${contextData.preferred_address} otra vez?`,
      primary_address: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿${contextData.primary_address} otra vez?`,
      known_customer: `High Mountain Taxi, habla Claire. ${name ? `Hola ${name}, ` : ''}¿dónde te recojo?`,
      new_customer: `High Mountain Taxi, habla Claire. ¿Dónde te recojo?`
    },
    portuguese: {
      active_trip: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}sua corrida para ${contextData.destination_address} está confirmada para ${contextData.trip_time}. Precisa mudar alguma coisa?`,
      callback: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}precisa de outro táxi de onde te deixei em ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}parece que a ligação caiu. Onde estávamos?`,
      trip_discussion: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}pronto para reservar essa ${contextData.trip_discussion}?`,
      preferred_address: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}${contextData.preferred_address} de novo?`,
      primary_address: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}${contextData.primary_address} de novo?`,
      known_customer: `High Mountain Taxi, é a Claire. ${name ? `Oi ${name}, ` : ''}onde posso te pegar?`,
      new_customer: `High Mountain Taxi, é a Claire. Onde posso te pegar?`
    },
    german: {
      active_trip: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}Ihre Fahrt nach ${contextData.destination_address} ist für ${contextData.trip_time} bestätigt. Möchten Sie etwas ändern?`,
      callback: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}brauchen Sie ein weiteres Taxi von wo ich Sie in ${contextData.last_dropoff} abgesetzt habe?`,
      dropped_call: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}es scheint, als ob die Verbindung unterbrochen wurde. Wo waren wir?`,
      trip_discussion: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}bereit, diese ${contextData.trip_discussion} zu buchen?`,
      preferred_address: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}${contextData.preferred_address} wieder?`,
      primary_address: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}${contextData.primary_address} wieder?`,
      known_customer: `High Mountain Taxi, hier ist Claire. ${name ? `Hallo ${name}, ` : ''}wo können wir Sie abholen?`,
      new_customer: `High Mountain Taxi, hier ist Claire. Wo können wir Sie abholen?`
    },
    french: {
      active_trip: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}votre course vers ${contextData.destination_address} est confirmée pour ${contextData.trip_time}. Besoin de changer quelque chose?`,
      callback: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}besoin d'un autre taxi depuis où je vous ai déposé à ${contextData.last_dropoff}?`,
      dropped_call: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}on dirait que l'appel a été coupé. Où en étions-nous?`,
      trip_discussion: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}prêt à réserver cette ${contextData.trip_discussion}?`,
      preferred_address: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}${contextData.preferred_address} encore?`,
      primary_address: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}${contextData.primary_address} encore?`,
      known_customer: `High Mountain Taxi, ici Claire. ${name ? `Salut ${name}, ` : ''}où puis-je vous prendre?`,
      new_customer: `High Mountain Taxi, ici Claire. Où puis-je vous prendre?`
    }
  };

  const langGreetings = greetings[language] || greetings.english;
  return {
    text: langGreetings[scenario] || langGreetings.new_customer,
    language
  };
}

/**
 * Generate situational context for conversation guidance
 */
function generateSituationalContext(memory, icabbi) {
  const context = {
    suggest_luggage_question: false,
    suggest_skis_question: false, 
    suggest_mobility_question: false,
    callback_context: null,
    conversation_topics: memory?.conversation_topics || [],
    personal_context: memory?.personal_details || null
  };

  // Analyze last destination for contextual questions
  if (memory?.last_dropoff) {
    const lastDropoff = memory.last_dropoff.toLowerCase();
    
    if (lastDropoff.includes('airport')) {
      context.suggest_luggage_question = true;
    }
    
    if (lastDropoff.includes('buttermilk') || lastDropoff.includes('highlands') || 
        lastDropoff.includes('snowmass') || lastDropoff.includes('ajax')) {
      context.suggest_skis_question = true;
    }
    
    if (lastDropoff.includes('hospital') || lastDropoff.includes('clinic') || 
        lastDropoff.includes('medical')) {
      context.suggest_mobility_question = true;
    }
  }

  // Callback context for recent dropoffs
  if (memory?.last_dropoff && memory?.hours_since_last_call < 2) {
    context.callback_context = {
      suggest_return_trip: true,
      last_dropoff_location: memory.last_dropoff,
      time_since_dropoff: memory.hours_since_last_call
    };
  }

  return context;
}

/**
 * Generate call summaries for memory context
 */
function generateCallSummaries(memory) {
  if (!memory) return [];

  const summaries = [];
  
  // Current call summary
  if (memory.outcome) {
    let summary = `${memory.outcome}`;
    
    if (memory.last_pickup && memory.last_dropoff) {
      summary += ` - ${memory.last_pickup} to ${memory.last_dropoff}`;
    }
    
    if (memory.behavior) {
      summary += ` (${memory.behavior})`;
    }
    
    if (memory.special_instructions) {
      summary += ` - ${memory.special_instructions}`;
    }

    summaries.push({
      timestamp: memory.timestamp,
      summary,
      outcome: memory.outcome
    });
  }

  return summaries.slice(0, 3); // Last 3 summaries max
}

/**
 * Calculate hours since last call
 */
function calculateHoursSinceLastCall(timestamp) {
  if (!timestamp) return null;
  
  const lastCall = new Date(timestamp);
  const now = new Date();
  return Math.round((now - lastCall) / (1000 * 60 * 60) * 10) / 10; // Round to 1 decimal
}

/**
 * Normalize phone number to E.164 format  
 */
function normalizePhone(input) {
  if (!input) return null;
  
  let digits = String(input).replace(/\D/g, '');
  
  // 10 digits: assume US/Canada
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // 11 digits starting with 1: US/Canada with country code
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  // Already has + prefix
  if (String(input).startsWith('+')) {
    return input;
  }
  
  // Other international numbers
  return digits.length >= 10 ? `+${digits}` : null;
}

/**
 * JSON response helper
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}