// src/handlers/callcab-lookup-master.js
// Unified intelligence endpoint for Claire:
// - Combines memory (CALL_MEMORIES KV)
// - iCabbi lookup
// - Greeting generation
// - Situational context for follow-up questions

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ------------------ GREETING TEMPLATES ------------------

const GREETING_TEMPLATES = {
  active_trip: {
    english: (name, trip) =>
      `High Mountain Taxi, this is Claire. Hi ${name}. I see you have a ride from ${trip.pickup_address} to ${trip.destination_address} ${trip.pickup_time_human}. Want to modify it or book something else?`,
    spanish: (name, trip) =>
      `High Mountain Taxi, habla Claire. Hola ${name}. Veo que tienes un viaje de ${trip.pickup_address} a ${trip.destination_address} ${trip.pickup_time_human}. ¿Quieres modificarlo o reservar algo más?`,
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
    german: () =>
      `High Mountain Taxi, hier ist Claire. Wo sollen wir Sie abholen?`,
    french: () =>
      `High Mountain Taxi, c'est Claire. Où est-ce qu'on te prend?`,
  },
};

// ------------------ MAIN HANDLER ------------------

export async function handleCallcabLookupMaster(request, env) {
  const startTime = Date.now();

  try {
    const body = await request.json();

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

    console.log('[LookupMaster] Processing for:', phone);

    // Parallel fetch: memory + iCabbi
    const [memoryData, icabbiData] = await Promise.all([
      getMemoryForLookup(phone, env),
      fetchIcabbiData(phone, env),
    ]);

    // Optional: auto-create customer in iCabbi if not found and we have a name
    let finalIcabbiData = icabbiData;

    if (!icabbiData.found && (body.name || body.customer?.name)) {
      const fullName = body.customer?.name || body.name;
      console.log('[LookupMaster] Creating new iCabbi customer for', phone, fullName);

      try {
        const firstName = fullName.split(' ')[0] || fullName;
        const lastName =
          fullName.split(' ').slice(1).join(' ') || firstName;

        const createResponse = await fetch(
          `${env.ICABBI_BASE_URL}/customer.json`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.ICABBI_APP_KEY}:${env.ICABBI_SECRET}`,
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
          console.log(
            '[LookupMaster] Customer created:',
            newCustomer.user?.customer_id,
          );

          finalIcabbiData = {
            found: true,
            is_new_customer: true,
            user: newCustomer.user,
            hasActiveTrips: false,
            activeTrips: [],
          };
        } else {
          console.warn(
            '[LookupMaster] Customer create failed:',
            createResponse.status,
          );
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
        last_3_summaries: [], // reserved for future use
        last_dropoff: memoryData?.last_call?.last_dropoff || null,
        last_dropoff_coords: {
          lat: memoryData?.last_call?.last_dropoff_lat || null,
          lng: memoryData?.last_call?.last_dropoff_lng || null,
        },
        hours_since_last_call: memoryData?.last_call?.hours_ago || null,
        behavior_flags: memoryData?.last_call?.behavior || null,
        priority_notes: memoryData?.last_call?.special_instructions || null,
        total_rides:
          memoryData?.aggregated_context?.behavioral_pattern?.total_recent ||
          0,
      },

      icabbi: {
        found: finalIcabbiData?.found || false,
        hasActiveTrips: finalIcabbiData?.hasActiveTrips || false,
        active_trip: finalIcabbiData?.nextTrip
          ? {
              trip_id: finalIcabbiData.nextTrip.trip_id,
              pickup_address: finalIcabbiData.nextTrip.pickup_address,
              destination_address:
                finalIcabbiData.nextTrip.destination_address,
              pickup_time: finalIcabbiData.nextTrip.pickup_date,
              pickup_time_human:
                finalIcabbiData.nextTrip.pickup_local_text || 'soon',
              status: finalIcabbiData.nextTrip.status,
            }
          : null,
        upcoming_trips_count: finalIcabbiData?.activeTrips?.length || 0,
        primary_address: finalIcabbiData?.primaryAddress || null,
      },

      system: {
        greeting_language: greeting.language,
        greeting_text: greeting.text,
        scenario: greeting.scenario,
        situational_context: situationalContext,
        processing_time_ms: processingTime,
      },
    };

    console.log('[LookupMaster] Success:', {
      phone,
      scenario: greeting.scenario,
      language: greeting.language,
      processing_time_ms: processingTime,
    });

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[LookupMaster] Error:', error);

    return new Response(
      JSON.stringify({
        ok: false,
        error: 'LOOKUP_FAILED',
        message: error.message,
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      },
    );
  }
}

// ------------------ HELPER FUNCTIONS ------------------


// Helper function for formatting local time (add this near the top with other helpers)
function formatLocalText(iso, tz = 'America/Denver') {
  if (!iso) return null;
  
  try {
    const src = new Date(iso);
    const now = new Date();
    
    // Get date parts in local timezone
    const fmtDate = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const fmtTime = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: '2-digit'
    });
    
    const dateParts = fmtDate.formatToParts(src);
    const targetMonth = dateParts.find(p => p.type === 'month')?.value;
    const targetDay = dateParts.find(p => p.type === 'day')?.value;
    
    const nowParts = fmtDate.formatToParts(now);
    const nowMonth = nowParts.find(p => p.type === 'month')?.value;
    const nowDay = nowParts.find(p => p.type === 'day')?.value;
    
    const timeLabel = fmtTime.format(src);
    
    // Check if today or tomorrow
    if (targetMonth === nowMonth && targetDay === nowDay) {
      return `today at ${timeLabel}`;
    }
    
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowParts = fmtDate.formatToParts(tomorrow);
    const tomorrowMonth = tomorrowParts.find(p => p.type === 'month')?.value;
    const tomorrowDay = tomorrowParts.find(p => p.type === 'day')?.value;
    
    if (targetMonth === tomorrowMonth && targetDay === tomorrowDay) {
      return `tomorrow at ${timeLabel}`;
    }
    
    // Otherwise full format
    const dateLabel = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(src);
    
    return `${dateLabel} at ${timeLabel}`;
  } catch (err) {
    console.error('[formatLocalText] Error:', err);
    return iso;
  }
}


async function fetchIcabbiData(phone, env) {
  console.log('[iCabbi] ========== START FETCH ==========');
  console.log('[iCabbi] Input phone:', phone);
  console.log('[iCabbi] Environment check:', {
    hasBaseUrl: !!env.ICABBI_BASE_URL,
    hasAppKey: !!env.ICABBI_APP_KEY,
    hasSecret: !!env.ICABBI_SECRET,
    baseUrl: env.ICABBI_BASE_URL
  });
  
  try {
    const BASE = (env.ICABBI_BASE_URL || 'https://api.icabbi.us/us2').replace(/\/+$/, '');
    const appKey = env.ICABBI_APP_KEY;
    const secret = env.ICABBI_SECRET;
    
    if (!appKey || !secret) {
      console.error('[iCabbi] ❌ Missing credentials');
      return { found: false, hasActiveTrips: false, error: 'MISSING_CREDENTIALS' };
    }
    
    console.log('[iCabbi] ✅ Credentials present');
    console.log('[iCabbi] Base URL:', BASE);
    
    // Create Basic auth header
    const basicAuth = btoa(`${appKey}:${secret}`);
    console.log('[iCabbi] Auth header created (first 20 chars):', basicAuth.substring(0, 20) + '...');
    
    const BASE_HEADERS = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Basic ${basicAuth}`
    };
    
    // Normalize phone to multiple formats
    const digits = String(phone).replace(/\D/g, '');
    console.log('[iCabbi] Digits only:', digits);
    
    const norm = digits.replace(/^1?(\d{10})$/, '$1');
    console.log('[iCabbi] Normalized (10 digits):', norm);
    
    const e164 = `+1${norm}`;
    const idd = `001${norm}`;
    const raw = String(phone).trim();
    
    const formats = Array.from(new Set([idd, e164, norm, raw])).filter(v => v && v.length >= 7);
    console.log('[iCabbi] Will try formats:', formats);
    
    let user = null;
    let lastError = null;
    
    // Try header-based lookup
    for (const p of formats) {
      console.log(`[iCabbi] Trying header method with format: ${p}`);
      
      try {
        const url = `${BASE}/users/index`;
        console.log('[iCabbi] Fetching:', url);
        console.log('[iCabbi] Headers:', { ...BASE_HEADERS, Phone: p });
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            ...BASE_HEADERS,
            'Phone': p
          }
        });
        
        console.log('[iCabbi] Response status:', response.status);
        console.log('[iCabbi] Response ok:', response.ok);
        
        const responseText = await response.text();
        console.log('[iCabbi] Response text (first 200 chars):', responseText.substring(0, 200));
        
        let data;
        try {
          data = JSON.parse(responseText);
          console.log('[iCabbi] Parsed JSON successfully');
          console.log('[iCabbi] Has body.user?', !!data?.body?.user);
        } catch (parseErr) {
          console.error('[iCabbi] JSON parse failed:', parseErr.message);
          lastError = `JSON parse error: ${parseErr.message}`;
          continue;
        }
        
        user = data?.body?.user || null;
        
        if (user) {
          console.log('[iCabbi] ✅ Found user via header!', {
            format: p,
            id: user.id,
            name: user.name,
            phone: user.phone
          });
          break;
        } else {
          console.log('[iCabbi] ❌ No user in response body');
          console.log('[iCabbi] Full response body:', JSON.stringify(data, null, 2));
        }
      } catch (err) {
        console.error('[iCabbi] ❌ Header attempt error:', err.message);
        console.error('[iCabbi] Error stack:', err.stack);
        lastError = err.message;
      }
    }
    
    // Try query parameter lookup if header failed
    if (!user) {
      console.log('[iCabbi] Header methods failed, trying query params...');
      
      for (const p of formats) {
        console.log(`[iCabbi] Trying query method with format: ${p}`);
        
        try {
          const url = `${BASE}/users/index?phone=${encodeURIComponent(p)}`;
          console.log('[iCabbi] Fetching:', url);
          
          const response = await fetch(url, {
            method: 'POST',
            headers: BASE_HEADERS
          });
          
          console.log('[iCabbi] Response status:', response.status);
          
          const responseText = await response.text();
          console.log('[iCabbi] Response text (first 200 chars):', responseText.substring(0, 200));
          
          let data;
          try {
            data = JSON.parse(responseText);
            console.log('[iCabbi] Parsed JSON successfully');
          } catch (parseErr) {
            console.error('[iCabbi] JSON parse failed:', parseErr.message);
            lastError = `JSON parse error: ${parseErr.message}`;
            continue;
          }
          
          user = data?.body?.user || null;
          
          if (user) {
            console.log('[iCabbi] ✅ Found user via query!', {
              format: p,
              id: user.id,
              name: user.name
            });
            break;
          } else {
            console.log('[iCabbi] ❌ No user in response body');
          }
        } catch (err) {
          console.error('[iCabbi] ❌ Query attempt error:', err.message);
          lastError = err.message;
        }
      }
    }
    
    if (!user) {
      console.error('[iCabbi] ❌ No user found after all attempts');
      console.error('[iCabbi] Last error:', lastError);
      return { 
        found: false, 
        hasActiveTrips: false,
        phoneTried: formats,
        lastError: lastError,
        debug: {
          baseUrl: BASE,
          hasAuth: !!basicAuth,
          formatsAttempted: formats.length
        }
      };
    }
    
    console.log('[iCabbi] ✅ User found, continuing with address/booking lookup...');
    
    // Rest of the function continues as before...
    const phoneForHistory = user.phone || formats[0];
    
    // Simplified return for debugging
    return {
      found: true,
      user: {
        id: user.id,
        customer_id: user.id,
        phone: user.phone,
        name: user.name || null,
        first_name: user.first_name || null,
        last_name: user.last_name || null,
        vip: !!user.vip,
        banned: !!user.banned
      },
      hasActiveTrips: false,
      activeTrips: [],
      debug: {
        message: 'User lookup successful, address/booking lookup not yet implemented in debug version'
      }
    };
    
  } catch (error) {
    console.error('[iCabbi] ❌❌❌ FATAL ERROR ❌❌❌');
    console.error('[iCabbi] Error message:', error.message);
    console.error('[iCabbi] Error stack:', error.stack);
    console.error('[iCabbi] Error name:', error.name);
    
    return { 
      found: false, 
      hasActiveTrips: false,
      error: error.message,
      errorStack: error.stack
    };
  }
}

async function getMemoryForLookup(phone, env) {
  if (!env.CALL_MEMORIES) {
    console.warn('[Memory] CALL_MEMORIES KV not configured');
    return { has_memory: false };
  }

  try {
    const latestStr = await env.CALL_MEMORIES.get(`latest:${phone}`);

    if (!latestStr) {
      console.log('[Memory] No memory found for:', phone);
      return { has_memory: false };
    }

    const latest = JSON.parse(latestStr);
    const now = new Date();
    const timestamp = new Date(latest.timestamp);
    const hours_ago = (now - timestamp) / 3600000;
    const minutes_ago = (now - timestamp) / 60000;

    console.log('[Memory] Found memory:', {
      phone,
      hours_ago: Math.round(hours_ago * 10) / 10,
      has_aggregated: !!latest.aggregated_context,
    });

    return {
      has_memory: true,
      last_call: {
        timestamp: latest.timestamp,
        hours_ago,
        minutes_ago,
        outcome: latest.outcome,
        last_pickup: latest.last_pickup,
        last_dropoff: latest.last_dropoff,
        last_dropoff_lat: latest.last_dropoff_lat,
        last_dropoff_lng: latest.last_dropoff_lng,
        behavior: latest.behavior,
        was_dropped: latest.was_dropped || false,
        conversation_state: latest.conversation_state,
        collected_info: latest.collected_info,
        trip_discussion: latest.trip_discussion,
        special_instructions: latest.special_instructions,
      },
      aggregated_context: latest.aggregated_context || {},
    };
  } catch (error) {
    console.error('[Memory] Retrieval failed:', error);
    return { has_memory: false, error: error.message };
  }
}

function generateGreeting(memoryData, icabbiData) {
  // Determine language (non-English only if explicitly stored)
  let language = 'english';
  if (
    memoryData?.aggregated_context?.preferred_language &&
    memoryData.aggregated_context.preferred_language !== 'english'
  ) {
    language = memoryData.aggregated_context.preferred_language;
  }
  if (!['english', 'spanish', 'german', 'french'].includes(language)) {
    language = 'english';
  }

  // Determine name
  let name = 'there';
  if (memoryData?.aggregated_context?.preferred_name) {
    name = memoryData.aggregated_context.preferred_name;
  } else if (memoryData?.last_call?.preferred_name) {
    name = memoryData.last_call.preferred_name;
  } else if (icabbiData?.user?.first_name) {
    name = icabbiData.user.first_name;
  }

  // 1) Active trip
  if (icabbiData?.hasActiveTrips && icabbiData?.nextTrip) {
    const trip = {
      pickup_address: icabbiData.nextTrip.pickup_address || 'your location',
      destination_address:
        icabbiData.nextTrip.destination_address || 'your destination',
      pickup_time_human: icabbiData.nextTrip.pickup_local_text || 'soon',
    };

    return {
      scenario: 'active_trip',
      language,
      text: GREETING_TEMPLATES.active_trip[language](name, trip),
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
      text: GREETING_TEMPLATES.callback[language](
        name,
        memoryData.last_call.last_dropoff,
      ),
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
      text: GREETING_TEMPLATES.dropped_call[language](name, contextText),
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
      text: GREETING_TEMPLATES.trip_discussion[language](
        name,
        memoryData.last_call.trip_discussion,
      ),
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
      text: GREETING_TEMPLATES.preferred_address[language](
        name,
        memoryData.aggregated_context.preferred_pickup_address,
      ),
      context: {
        preferred_pickup_address:
          memoryData.aggregated_context.preferred_pickup_address,
      },
    };
  }

  // 6) iCabbi primary address
  if (icabbiData?.primaryAddress) {
    return {
      scenario: 'primary_address',
      language,
      text: GREETING_TEMPLATES.primary_address[language](
        name,
        icabbiData.primaryAddress,
      ),
      context: {
        primary_address: icabbiData.primaryAddress,
      },
    };
  }

  // 7) Known customer, no special context
  if (icabbiData?.found && name) {
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

function buildSituationalContext(memoryData, icabbiData, greeting) {
  const context = {
    suggest_luggage_question: false,
    suggest_skis_question: false,
    suggest_mobility_question: false,
    weather_mention: null,
  };

  const addrFromTrip = icabbiData?.nextTrip?.destination_address || '';
  const addrFromPref =
    memoryData?.aggregated_context?.preferred_pickup_address || '';
  const addresses = `${addrFromTrip} ${addrFromPref}`.toLowerCase();

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

  const skiKeywords = [
    'aspen mountain',
    'ajax',
    'highlands',
    'snowmass',
    'buttermilk',
  ];
  const isSkiTrip = skiKeywords.some((kw) => addresses.includes(kw));
  if (isSkiTrip) {
    context.suggest_skis_question = true;
  }

  const isHospitalTrip = addresses.includes('hospital');
  if (isHospitalTrip) {
    context.suggest_mobility_question = true;
  }

  return context;
}

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