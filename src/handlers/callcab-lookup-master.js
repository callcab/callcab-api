// src/handlers/callcab-lookup-master.js
// Production version - unified intelligence endpoint for Claire
// Combines memory (CALL_MEMORIES KV), iCabbi lookup, and greeting generation

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Security: Allowed caller IDs (High Mountain Taxi VAPI numbers)
// Add your actual VAPI phone numbers here
const ALLOWED_CALLERS = [
  '+19702000000', // Replace with your actual VAPI number(s)
  // Add more as needed
];

// Greeting templates in multiple languages
const GREETING_TEMPLATES = {
  active_trip: {
    english: (name, trip) =>
      `High Mountain Taxi, this is Claire. Hi ${name}. I see you have a ride from ${trip.pickup_address} to ${trip.destination_address} ${trip.pickup_time_human}. Want to modify it or book something else?`,
    spanish: (name, trip) =>
      `High Mountain Taxi, habla Claire. Hola ${name}. Veo que tienes un viaje de ${trip.pickup_address} a ${trip.destination_address} ${trip.pickup_time_human}. ¿Quieres modificarlo o reservar algo más?`,
    portuguese: (name, trip) =>
      `High Mountain Taxi, aqui é Claire. Olá ${name}. Vejo que você tem uma viagem de ${trip.pickup_address} para ${trip.destination_address} ${trip.pickup_time_human}. Quer modificar ou reservar outra coisa?`,
    german: (name, trip) =>
      `High Mountain Taxi, hier ist Claire. Hallo ${name}. Ich sehe, Sie haben eine Fahrt von ${trip.pickup_address} nach ${trip.destination_address} ${trip.pickup_time_human}. Möchten Sie das ändern oder etwas anderes buchen?`,
    french: (name, trip) =>
      `High Mountain Taxi, c'est Claire. Salut ${name}. Je vois que tu as un trajet de ${trip.pickup_address} à ${trip.destination_address} ${trip.pickup_time_human}. Tu veux le modifier ou réserver autre chose?`,
  },
  callback: {
    english: (name, address) =>
      `High Mountain Taxi, this is Claire. Hi ${name}. Want a pickup from where I dropped you off at ${address}?`,
    spanish: (name, address) =>
      `High Mountain Taxi, habla Claire. Hola ${name}. ¿Quieres que te recoja donde te dejé en ${address}?`,
    portuguese: (name, address) =>
      `High Mountain Taxi, aqui é Claire. Olá ${name}. Quer que eu te pegue onde te deixei em ${address}?`,
    german: (name, address) =>
      `High Mountain Taxi, hier ist Claire. Hallo ${name}. Soll ich Sie dort abholen, wo ich Sie bei ${address} abgesetzt habe?`,
    french: (name, address) =>
      `High Mountain Taxi, c'est Claire. Salut ${name}. Tu veux que je te prenne là où je t'ai déposé à ${address}?`,
  },
  dropped_call: {
    english: (name, context) =>
      `Hi ${name}, it's Claire. We got disconnected earlier. ${context}`,
    spanish: (name, context) =>
      `Hola ${name}, es Claire. Se cortó la llamada. ${context}`,
    portuguese: (name, context) =>
      `Oi ${name}, é a Claire. A ligação caiu. ${context}`,
    german: (name, context) =>
      `Hallo ${name}, hier ist Claire. Wir wurden unterbrochen. ${context}`,
    french: (name, context) =>
      `Salut ${name}, c'est Claire. On a été coupés. ${context}`,
  },
  trip_discussion: {
    english: (name, discussion) =>
      `High Mountain Taxi, this is Claire. Hi ${name}. Still planning ${discussion}?`,
    spanish: (name, discussion) =>
      `High Mountain Taxi, habla Claire. Hola ${name}. ¿Todavía planeas ${discussion}?`,
    portuguese: (name, discussion) =>
      `High Mountain Taxi, aqui é Claire. Olá ${name}. Ainda planejando ${discussion}?`,
    german: (name, discussion) =>
      `High Mountain Taxi, hier ist Claire. Hallo ${name}. Planen Sie noch ${discussion}?`,
    french: (name, discussion) =>
      `High Mountain Taxi, c'est Claire. Salut ${name}. Tu prévois toujours ${discussion}?`,
  },
  preferred_address: {
    english: (name, address) =>
      `High Mountain Taxi, this is Claire. Hi ${name}. ${address} again?`,
    spanish: (name, address) =>
      `High Mountain Taxi, habla Claire. Hola ${name}. ¿${address} otra vez?`,
    portuguese: (name, address) =>
      `High Mountain Taxi, aqui é Claire. Olá ${name}. ${address} de novo?`,
    german: (name, address) =>
      `High Mountain Taxi, hier ist Claire. Hallo ${name}. ${address} wieder?`,
    french: (name, address) =>
      `High Mountain Taxi, c'est Claire. Salut ${name}. ${address} encore?`,
  },
  primary_address: {
    english: (name, address) =>
      `High Mountain Taxi, this is Claire. Hi ${name}. ${address} again?`,
    spanish: (name, address) =>
      `High Mountain Taxi, habla Claire. Hola ${name}. ¿${address} otra vez?`,
    portuguese: (name, address) =>
      `High Mountain Taxi, aqui é Claire. Olá ${name}. ${address} de novo?`,
    german: (name, address) =>
      `High Mountain Taxi, hier ist Claire. Hallo ${name}. ${address} wieder?`,
    french: (name, address) =>
      `High Mountain Taxi, c'est Claire. Salut ${name}. ${address} encore?`,
  },
  known_customer: {
    english: (name) =>
      `High Mountain Taxi, this is Claire. Hi ${name}, where can we pick you up?`,
    spanish: (name) =>
      `High Mountain Taxi, habla Claire. Hola ${name}, ¿dónde te recojo?`,
    portuguese: (name) =>
      `High Mountain Taxi, aqui é Claire. Olá ${name}, onde posso te pegar?`,
    german: (name) =>
      `High Mountain Taxi, hier ist Claire. Hallo ${name}, wo sollen wir Sie abholen?`,
    french: (name) =>
      `High Mountain Taxi, c'est Claire. Salut ${name}, où est-ce qu'on te prend?`,
  },
  new_customer: {
    english: () =>
      `High Mountain Taxi, this is Claire. Where can we pick you up?`,
    spanish: () =>
      `High Mountain Taxi, habla Claire. ¿Dónde te recojo?`,
    portuguese: () =>
      `High Mountain Taxi, aqui é Claire. Onde posso te pegar?`,
    german: () =>
      `High Mountain Taxi, hier ist Claire. Wo sollen wir Sie abholen?`,
    french: () =>
      `High Mountain Taxi, c'est Claire. Où est-ce qu'on te prend?`,
  },
};

// Main handler
export async function handleCallcabLookupMaster(request, env) {
  const startTime = Date.now();

  try {
    const body = await request.json();

    // Extract phone number
    const phone = normalizePhone(
      body.phone ||
        body.customer?.number ||
        body.call?.customer?.number,
    );

    if (!phone) {
      console.error('[LookupMaster] MISSING_PHONE');
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'MISSING_PHONE',
          message: 'Phone number is required',
        }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        },
      );
    }

    // SECURITY: Verify caller is from allowed list (optional - comment out if not needed)
    // Uncomment and configure ALLOWED_CALLERS at top of file
    /*
    const callerNumber = body.call?.customer?.number || body.customer?.number;
    if (callerNumber && !ALLOWED_CALLERS.includes(normalizePhone(callerNumber))) {
      console.error('[LookupMaster] UNAUTHORIZED_CALLER:', callerNumber);
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'UNAUTHORIZED',
          message: 'This service is only available to High Mountain Taxi customers'
        }),
        { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    */

    console.log('[LookupMaster] Processing for:', phone);

    // Parallel fetch: memory + iCabbi
    const [memoryData, icabbiData] = await Promise.all([
      getMemoryForLookup(phone, env),
      fetchIcabbiData(phone, env),
    ]);

    // Optional: auto-create customer in iCabbi if not found
    let finalIcabbiData = icabbiData;

    if (!icabbiData.found && (body.name || body.customer?.name)) {
      const fullName = body.customer?.name || body.name;
      console.log('[LookupMaster] Creating new iCabbi customer for', phone, fullName);

      try {
        const firstName = fullName.split(' ')[0] || fullName;
        const lastName = fullName.split(' ').slice(1).join(' ') || firstName;

        // NOTE: Endpoint may need adjustment - verify with iCabbi API docs
        // Using same auth method as search endpoint
        const createResponse = await fetch(
          `${env.ICABBI_BASE_URL}/customer.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-App-Key': env.ICABBI_APP_KEY,
              'X-Secret': env.ICABBI_SECRET,
            },
            body: JSON.stringify({
              action: 'create',
              phone: phone,
              userData: {
                first_name: firstName,
                last_name: lastName,
              },
            }),
          },
        );

        if (createResponse.ok) {
          const newCustomer = await createResponse.json();
          console.log('[LookupMaster] Customer created:', newCustomer.user?.customer_id);

          finalIcabbiData = {
            found: true,
            is_new_customer: true,
            user: newCustomer.user,
            hasActiveTrips: false,
            activeTrips: [],
          };
        } else {
          console.warn('[LookupMaster] Customer create failed:', createResponse.status);
        }
      } catch (err) {
        console.error('[LookupMaster] Customer creation error:', err);
      }
    }

    // Build greeting + situational context
    const greeting = generateGreeting(memoryData, finalIcabbiData);
    const situationalContext = buildSituationalContext(
      memoryData,
      finalIcabbiData,
      greeting,
    );

    const processingTime = Date.now() - startTime;

    const response = {
      ok: true,

      customer: {
        phone: phone,
        icabbi_customer_id: finalIcabbiData?.user?.customer_id || null,
        is_new_customer: finalIcabbiData?.is_new_customer || false,
        preferred_name:
          memoryData?.aggregated_context?.preferred_name ||
          finalIcabbiData?.user?.first_name ||
          null,
        preferred_language:
          memoryData?.aggregated_context?.preferred_language || 'english',
        preferred_pickup_address:
          memoryData?.aggregated_context?.preferred_pickup_address ||
          finalIcabbiData?.primaryAddress ||
          null,
        vip_status: finalIcabbiData?.user?.vip || false,
      },

      memory: {
        has_memory: memoryData?.has_memory || false,
        last_3_summaries: memoryData?.last_3_summaries || [],
        last_dropoff: memoryData?.last_call?.last_dropoff || null,
        last_dropoff_coords: {
          lat: memoryData?.last_call?.last_dropoff_lat || null,
          lng: memoryData?.last_call?.last_dropoff_lng || null,
        },
        hours_since_last_call: memoryData?.last_call?.hours_ago || null,
        behavior_flags: memoryData?.last_call?.behavior || null,
        priority_notes: memoryData?.last_call?.special_instructions || null,
        total_rides: memoryData?.aggregated_context?.total_recent || 0,
      },

      icabbi: {
        found: finalIcabbiData?.found || false,
        hasActiveTrips: finalIcabbiData?.hasActiveTrips || false,
        active_trip: finalIcabbiData?.nextTrip
          ? {
              trip_id: finalIcabbiData.nextTrip.trip_id,
              pickup_address: finalIcabbiData.nextTrip.pickup_address,
              destination_address: finalIcabbiData.nextTrip.destination_address,
              pickup_time: finalIcabbiData.nextTrip.pickup_local_text,
              status: finalIcabbiData.nextTrip.status,
            }
          : null,
        primary_address: finalIcabbiData?.primaryAddress || null,
        upcoming_trips_count: finalIcabbiData?.activeTrips?.length || 0,
      },

      system: {
        scenario: greeting.scenario,
        greeting_text: greeting.text,
        greeting_language: greeting.language,
        processing_time_ms: processingTime,
        situational_context: situationalContext,
      },
    };

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[LookupMaster] Error:', error);
    console.error('[LookupMaster] Stack:', error.stack);
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'LOOKUP_FAILED',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }
}

// Fetch iCabbi customer data
// FIXED: Uses correct /users/search endpoint with POST method
async function fetchIcabbiData(phone, env) {
  try {
    if (!env.ICABBI_BASE_URL || !env.ICABBI_APP_KEY) {
      console.warn('[iCabbi] Not configured, skipping');
      return { found: false };
    }

    // CORRECTED: Use /users/search endpoint with POST method and correct headers
    const response = await fetch(
      `${env.ICABBI_BASE_URL}/users/search`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Key': env.ICABBI_APP_KEY,
          'X-Secret': env.ICABBI_SECRET,
        },
        body: JSON.stringify({
          phone: phone,
          checkActiveTrips: true
        })
      },
    );

    if (!response.ok) {
      console.error('[iCabbi] Lookup failed:', response.status);
      return { found: false };
    }

    const data = await response.json();
    
    // Handle response structure from /users/search
    // May return single user or array of users
    if (!data.user && !data.users) {
      return { found: false };
    }

    const user = data.user || (data.users && data.users[0]);
    
    if (!user) {
      return { found: false };
    }

    // Get primary address
    let primaryAddress = null;
    if (user.addresses && user.addresses.length > 0) {
      const primary = user.addresses.find(a => a.is_primary) || user.addresses[0];
      if (primary) {
        primaryAddress = primary.formatted_address || 
                        `${primary.address1 || ''} ${primary.address2 || ''}`.trim();
      }
    }

    // Get active trips
    const now = new Date();
    const activeTrips = (user.trips || [])
      .filter(trip => {
        const tripTime = new Date(trip.pickup_time);
        return tripTime > now && trip.status !== 'cancelled';
      })
      .sort((a, b) => new Date(a.pickup_time) - new Date(b.pickup_time));

    const nextTrip = activeTrips.length > 0 ? activeTrips[0] : null;

    // Format next trip time
    if (nextTrip) {
      const tripTime = new Date(nextTrip.pickup_time);
      const denver = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Denver',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }).format(tripTime);
      
      nextTrip.pickup_local_text = denver.toLowerCase();
    }

    return {
      found: true,
      user: user,
      primaryAddress,
      hasActiveTrips: activeTrips.length > 0,
      activeTrips,
      nextTrip,
    };
  } catch (error) {
    console.error('[iCabbi] Error:', error);
    return { found: false, error: error.message };
  }
}

// Get memory for lookup with last 3 summaries
async function getMemoryForLookup(phone, env) {
  try {
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return { has_memory: false, error: 'Invalid phone' };
    }

    if (!env.CALL_MEMORIES) {
      console.warn('[Memory] KV not configured');
      return { has_memory: false };
    }

    // Get latest call memory
    const latestKey = `latest:${normalizedPhone}`;
    const latestData = await env.CALL_MEMORIES.get(latestKey);
    
    if (!latestData) {
      return { has_memory: false };
    }

    const latest = JSON.parse(latestData);
    const timestamp = new Date(latest.timestamp);
    const hoursAgo = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60);

    // Get last 3 call summaries
    const last3Summaries = await getLastThreeSummaries(normalizedPhone, env);

    return {
      has_memory: true,
      last_call: {
        timestamp: latest.timestamp,
        hours_ago: hoursAgo,
        outcome: latest.outcome,
        behavior: latest.behavior,
        behavior_notes: latest.behavior_notes,
        was_dropped: latest.was_dropped,
        last_dropoff: latest.last_dropoff,
        last_dropoff_lat: latest.last_dropoff_lat,
        last_dropoff_lng: latest.last_dropoff_lng,
        conversation_state: latest.conversation_state,
        collected_info: latest.collected_info,
        greeting_response: latest.greeting_response,
        relationship_context: latest.relationship_context,
        trip_discussion: latest.trip_discussion,
        special_instructions: latest.special_instructions,
      },
      last_3_summaries: last3Summaries,
      aggregated_context: latest.aggregated_context || {},
    };
  } catch (error) {
    console.error('[Memory] Retrieval failed:', error);
    return { has_memory: false, error: error.message };
  }
}

// Get last 3 call summaries from history
async function getLastThreeSummaries(phone, env) {
  try {
    const prefix = `history:${phone}:`;
    const list = await env.CALL_MEMORIES.list({ prefix, limit: 100 });
    
    if (!list.keys || list.keys.length === 0) {
      return [];
    }

    // Sort by timestamp (most recent first)
    const sortedKeys = list.keys
      .sort((a, b) => {
        const timeA = a.name.split(':')[2];
        const timeB = b.name.split(':')[2];
        return timeB.localeCompare(timeA);
      })
      .slice(0, 3);

    // Fetch actual data
    const summaries = await Promise.all(
      sortedKeys.map(async (key) => {
        const data = await env.CALL_MEMORIES.get(key.name);
        if (!data) return null;
        
        const parsed = JSON.parse(data);
        return buildCallSummary(parsed);
      })
    );

    return summaries.filter(s => s !== null);
  } catch (error) {
    console.error('[Memory] Failed to get last 3 summaries:', error);
    return [];
  }
}

// Build human-readable call summary
function buildCallSummary(callData) {
  const timestamp = new Date(callData.timestamp);
  const hoursAgo = (Date.now() - timestamp.getTime()) / (1000 * 60 * 60);
  
  let summary = '';
  
  // Time reference
  if (hoursAgo < 1) {
    summary = `${Math.round(hoursAgo * 60)} minutes ago`;
  } else if (hoursAgo < 24) {
    summary = `${Math.round(hoursAgo)} hours ago`;
  } else {
    summary = `${Math.round(hoursAgo / 24)} days ago`;
  }
  
  // Call outcome
  switch (callData.outcome) {
    case 'booking_created':
      summary += `: Booked ${callData.last_pickup || 'pickup'} to ${callData.last_dropoff || 'destination'}`;
      break;
    case 'booking_modified':
      summary += `: Modified existing booking`;
      break;
    case 'booking_cancelled':
      summary += `: Cancelled booking`;
      break;
    case 'dropped_call':
      summary += `: Call dropped during ${callData.conversation_state || 'conversation'}`;
      break;
    case 'info_provided':
      summary += `: Asked for information`;
      break;
    default:
      summary += `: ${callData.outcome || 'Call completed'}`;
  }
  
  // Behavioral notes
  if (callData.behavior && callData.behavior !== 'neutral') {
    summary += ` (${callData.behavior})`;
  }
  
  return {
    timestamp: callData.timestamp,
    hours_ago: hoursAgo,
    summary: summary,
    outcome: callData.outcome,
    locations: {
      pickup: callData.last_pickup,
      dropoff: callData.last_dropoff
    },
    behavior: callData.behavior
  };
}

// Generate greeting based on memory and iCabbi data
function generateGreeting(memoryData, icabbiData) {
  // Determine language (non-English only if explicitly stored)
  let language = 'english';
  if (
    memoryData?.aggregated_context?.preferred_language &&
    memoryData.aggregated_context.preferred_language !== 'english'
  ) {
    language = memoryData.aggregated_context.preferred_language;
  }
  
  // Supported languages
  if (!['english', 'spanish', 'portuguese', 'german', 'french'].includes(language)) {
    language = 'english';
  }

  // Determine name
  let name = null;
  if (memoryData?.aggregated_context?.preferred_name) {
    name = memoryData.aggregated_context.preferred_name;
  } else if (icabbiData?.user?.first_name) {
    name = icabbiData.user.first_name;
  }

  // 1) Active trip
  if (icabbiData?.hasActiveTrips && icabbiData?.nextTrip) {
    const trip = {
      pickup_address: icabbiData.nextTrip.pickup_address || 'your location',
      destination_address: icabbiData.nextTrip.destination_address || 'your destination',
      pickup_time_human: icabbiData.nextTrip.pickup_local_text || 'soon',
    };

    return {
      scenario: 'active_trip',
      language,
      text: name 
        ? GREETING_TEMPLATES.active_trip[language](name, trip)
        : GREETING_TEMPLATES.active_trip[language]('there', trip),
      context: {
        has_active_trip: true,
        trip_id: icabbiData.nextTrip.trip_id,
      },
    };
  }

  // 2) Recent completed trip → callback
  if (
    memoryData?.last_call?.outcome === 'booking_created' &&
    memoryData?.last_call?.last_dropoff &&
    memoryData?.last_call?.hours_ago < 2
  ) {
    return {
      scenario: 'callback',
      language,
      text: name
        ? GREETING_TEMPLATES.callback[language](name, memoryData.last_call.last_dropoff)
        : GREETING_TEMPLATES.callback[language]('there', memoryData.last_call.last_dropoff),
      context: {
        last_dropoff: memoryData.last_call.last_dropoff,
        last_dropoff_coords: {
          lat: memoryData.last_call.last_dropoff_lat,
          lng: memoryData.last_call.last_dropoff_lng,
        },
      },
    };
  }

  // 3) Dropped call within last hour
  if (memoryData?.last_call?.was_dropped && memoryData.last_call.hours_ago < 1) {
    const contextText = getDroppedCallContext(memoryData.last_call);

    return {
      scenario: 'dropped_call',
      language,
      text: name
        ? GREETING_TEMPLATES.dropped_call[language](name, contextText)
        : GREETING_TEMPLATES.dropped_call[language]('there', contextText),
      context: {
        was_dropped: true,
        conversation_state: memoryData.last_call.conversation_state,
      },
    };
  }

  // 4) Trip discussion in memory
  if (memoryData?.last_call?.trip_discussion) {
    return {
      scenario: 'trip_discussion',
      language,
      text: name
        ? GREETING_TEMPLATES.trip_discussion[language](name, memoryData.last_call.trip_discussion)
        : GREETING_TEMPLATES.trip_discussion[language]('there', memoryData.last_call.trip_discussion),
      context: {
        trip_discussion: memoryData.last_call.trip_discussion,
      },
    };
  }

  // 5) Preferred pickup address from aggregated context
  if (memoryData?.aggregated_context?.preferred_pickup_address) {
    return {
      scenario: 'preferred_address',
      language,
      text: name
        ? GREETING_TEMPLATES.preferred_address[language](
            name,
            memoryData.aggregated_context.preferred_pickup_address,
          )
        : GREETING_TEMPLATES.preferred_address[language](
            'there',
            memoryData.aggregated_context.preferred_pickup_address,
          ),
      context: {
        preferred_pickup_address: memoryData.aggregated_context.preferred_pickup_address,
      },
    };
  }

  // 6) iCabbi primary address
  if (icabbiData?.primaryAddress && name) {
    return {
      scenario: 'primary_address',
      language,
      text: GREETING_TEMPLATES.primary_address[language](name, icabbiData.primaryAddress),
      context: {
        primary_address: icabbiData.primaryAddress,
      },
    };
  }

  // 7) Known customer, no special context
  if (name) {
    return {
      scenario: 'known_customer',
      language,
      text: GREETING_TEMPLATES.known_customer[language](name),
      context: {
        known_customer: true,
      },
    };
  }

  // 8) New customer
  return {
    scenario: 'new_customer',
    language,
    text: GREETING_TEMPLATES.new_customer[language](),
    context: {
      new_customer: true,
    },
  };
}

// Get context text for dropped call recovery
function getDroppedCallContext(lastCall) {
  const collected = lastCall.collected_info || {};

  if (collected.has_pickup && !collected.has_destination) {
    return `You were at ${collected.pickup_address}. Where are you headed?`;
  }

  if (collected.has_destination && !collected.has_pickup) {
    return `You were going to ${collected.destination_address}. Where should I pick you up?`;
  }

  if (collected.has_pickup && collected.has_destination && !collected.has_time) {
    return `Were you confirming that ride from ${collected.pickup_address} to ${collected.destination_address}?`;
  }

  return 'Where were we?';
}

// Build situational context for follow-up questions
function buildSituationalContext(memoryData, icabbiData, greeting) {
  const context = {
    suggest_luggage_question: false,
    suggest_skis_question: false,
    suggest_mobility_question: false,
  };

  const addrFromTrip = icabbiData?.nextTrip?.destination_address || '';
  const addrFromPref = memoryData?.aggregated_context?.preferred_pickup_address || '';
  const addresses = `${addrFromTrip} ${addrFromPref}`.toLowerCase();

  // Airport detection
  const hasAirport =
    addresses.includes('airport') ||
    addresses.includes('ase') ||
    addresses.includes('eagle') ||
    addresses.includes('ege') ||
    addresses.includes('denver') ||
    addresses.includes('den');

  if (hasAirport) {
    context.suggest_luggage_question = true;
  }

  // Ski area detection
  const skiKeywords = ['aspen mountain', 'ajax', 'highlands', 'snowmass', 'buttermilk'];
  const isSkiTrip = skiKeywords.some((kw) => addresses.includes(kw));
  if (isSkiTrip) {
    context.suggest_skis_question = true;
  }

  // Hospital detection
  const isHospitalTrip = addresses.includes('hospital');
  if (isHospitalTrip) {
    context.suggest_mobility_question = true;
  }

  return context;
}

// Normalize phone number to E.164 format
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