// src/handlers/memory-store.js
// CLAIRE v4.2 - INTEGRATED Memory Store
// Works with callcab-lookup-master.js for seamless memory retrieval
// Key: Uses CONSISTENT phone format across all storage keys

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Handle memory store requests (end-of-call webhooks from Vapi)
 */
export async function handleMemoryStore(request, env) {
  const startTime = Date.now();

  try {
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
    // END-OF-CALL MESSAGE FILTERING
    // ========================================================================
    
    const messageType = body.message?.type || body.type;
    
    const isEndOfCall = (
      messageType === 'end-of-call-report' ||
      (messageType === 'status-update' && body.message?.status === 'ended') ||
      body.message?.endedAt ||
      body.call?.endedAt
    );
    
    if (!isEndOfCall) {
      console.log(`[MemoryStore] Skipping non-end-of-call message: ${messageType}`);
      return jsonResponse({
        ok: true,
        skipped: true,
        reason: 'Not an end-of-call message',
        message_type: messageType
      });
    }
    
    // ========================================================================
    // COMPREHENSIVE PHONE EXTRACTION (MATCHES LOOKUP-MASTER)
    // ========================================================================
    
    const rawPhone = extractPhoneComprehensive(body, request);
    
    if (!rawPhone) {
      console.error('[MemoryStore] MISSING_PHONE - no phone found in any source');
      return jsonResponse({
        ok: false,
        error: 'MISSING_PHONE',
        message: 'Could not extract phone number from any source',
        sources_checked: [
          'body.phone', 'body.message.artifact.phone', 
          'body.message.call.customer.number', 'body.call.customer.number',
          'body.customer.number', 'body.artifact.phone',
          'body.analysis.structuredData.phone', 'headers'
        ]
      }, 400);
    }
    
    // CRITICAL: Normalize to E.164 format (same as lookup-master)
    const phone = normalizePhone(rawPhone);
    
    if (!phone) {
      console.error('[MemoryStore] Invalid phone format:', rawPhone);
      return jsonResponse({
        ok: false,
        error: 'INVALID_PHONE',
        message: 'Phone number could not be normalized',
        raw_phone: rawPhone
      }, 400);
    }
    
    console.log(`[MemoryStore] Processing: ${phone} (from: ${rawPhone})`);
    
    // ========================================================================
    // EXTRACT STRUCTURED DATA FROM VAPI
    // ========================================================================
    
    const call = body.message?.call || body.call || {};
    const analysis = body.message?.analysis || body.analysis || {};
    const structuredData = analysis.structuredData || body.artifact || {};
    const summary = analysis.summary || 'Call completed';
    
    const now = new Date();
    const callId = call.id || `call-${Date.now()}`;
    
    const startTime_call = call.startedAt ? new Date(call.startedAt) : null;
    const endTime_call = call.endedAt ? new Date(call.endedAt) : now;
    const durationSeconds = startTime_call ? (endTime_call - startTime_call) / 1000 : null;
    
    const wasDropped = (
      call.endedReason === 'customer-ended-call' && 
      durationSeconds && 
      durationSeconds < 120
    ) || call.endedReason === 'customer-did-not-give-microphone-permission';

    // ========================================================================
    // GET EXISTING MEMORY FOR PREFERENCE PRESERVATION
    // ========================================================================
    
    const existingLatest = await getExistingMemory(phone, env);
    const existingPreferences = existingLatest?.aggregated_context || {};
    
    if (existingLatest) {
      console.log('[MemoryStore] Existing preferences:', {
        preferred_name: existingPreferences.preferred_name,
        preferred_language: existingPreferences.preferred_language,
        preferred_pickup_address: existingPreferences.preferred_pickup_address
      });
    }
    
    // ========================================================================
    // BULLETPROOF PREFERENCE PRESERVATION
    // ========================================================================
    
    const warnings = [];
    
    // Preserve language if not explicitly changed
    if (existingPreferences.preferred_language && !structuredData.preferred_language) {
      console.log(`[MemoryStore] Preserving preferred_language: ${existingPreferences.preferred_language}`);
      structuredData.preferred_language = existingPreferences.preferred_language;
      warnings.push('preferred_language_preserved');
    }
    
    // Preserve name if not explicitly corrected
    if (existingPreferences.preferred_name && !structuredData.preferred_name) {
      console.log(`[MemoryStore] Preserving preferred_name: ${existingPreferences.preferred_name}`);
      structuredData.preferred_name = existingPreferences.preferred_name;
      warnings.push('preferred_name_preserved');
    }
    
    // Preserve pickup address if not explicitly changed
    if (existingPreferences.preferred_pickup_address && !structuredData.preferred_pickup_address) {
      console.log(`[MemoryStore] Preserving preferred_pickup_address: ${existingPreferences.preferred_pickup_address}`);
      structuredData.preferred_pickup_address = existingPreferences.preferred_pickup_address;
      warnings.push('preferred_pickup_address_preserved');
    }
    
    // ========================================================================
    // BUILD MEMORY ENTRY
    // ========================================================================

    const memoryEntry = {
      call_id: callId,
      timestamp: now.toISOString(),
      phone: phone,  // CRITICAL: Store phone for reference
      
      summary: summary,
      outcome: structuredData.outcome || 'unknown',
      duration_seconds: Math.round(durationSeconds || 0),
      was_dropped: wasDropped,
      ended_reason: call.endedReason || null,
      
      // Trip info
      last_pickup: structuredData.last_pickup || null,
      last_pickup_lat: structuredData.last_pickup_lat || null,
      last_pickup_lng: structuredData.last_pickup_lng || null,
      last_dropoff: structuredData.last_dropoff || null,
      last_dropoff_lat: structuredData.last_dropoff_lat || null,
      last_dropoff_lng: structuredData.last_dropoff_lng || null,
      last_trip_id: structuredData.last_trip_id || null,
      account_used: structuredData.account_used || null,
      
      // Behavior
      behavior: structuredData.behavior || 'neutral',
      behavior_notes: structuredData.behavior_notes || null,
      
      // CRITICAL PREFERENCES
      preferred_name: structuredData.preferred_name || null,
      preferred_language: structuredData.preferred_language || null,
      preferred_pickup_address: structuredData.preferred_pickup_address || null,
      
      // Conversation context
      conversation_topics: structuredData.conversation_topics || [],
      jokes_shared: structuredData.jokes_shared || [],
      personal_details: structuredData.personal_details || {},
      trip_discussion: structuredData.trip_discussion || null,
      greeting_response: structuredData.greeting_response || null,
      relationship_context: structuredData.relationship_context || null,
      
      // Operational
      special_instructions: structuredData.special_instructions || null,
      special_notes: structuredData.special_notes || null,
      operational_notes: structuredData.operational_notes || null,
      
      // State for dropped call recovery
      conversation_state: structuredData.conversation_state || null,
      collected_info: structuredData.collected_info || null
    };

    // ========================================================================
    // GET/UPDATE HISTORY
    // ========================================================================
    
    const historyKey = `history:${phone}`;
    const existingHistoryStr = await env.CALL_MEMORIES.get(historyKey);
    let history = existingHistoryStr ? JSON.parse(existingHistoryStr) : [];
    
    // Add new entry at the front
    history.unshift(memoryEntry);
    
    // Keep 7 days of history
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    history = history.filter(entry => new Date(entry.timestamp) > sevenDaysAgo);
    
    // Safety cap at 50 entries
    if (history.length > 50) {
      history = history.slice(0, 50);
    }

    // ========================================================================
    // BUILD AGGREGATED CONTEXT FROM HISTORY
    // ========================================================================
    
    const aggregatedContext = buildAggregatedContext(history);
    const behavioralScore = calculateBehavioralScore(history);
    
    // Build last 3 summaries (CRITICAL for lookup-master)
    const last3Summaries = buildLast3Summaries(history);
    
    console.log('[MemoryStore] Aggregated context:', {
      preferred_name: aggregatedContext.preferred_name,
      preferred_language: aggregatedContext.preferred_language,
      preferred_pickup_address: aggregatedContext.preferred_pickup_address,
      total_calls: history.length
    });
    
    // ========================================================================
    // SAVE TO KV WITH REDUNDANCY
    // ========================================================================
    
    const redundancySaves = [];
    
    // SAVE 1: History (primary storage - 7 days TTL)
    try {
      await env.CALL_MEMORIES.put(
        historyKey,
        JSON.stringify(history),
        { expirationTtl: 7 * 24 * 60 * 60 }
      );
      redundancySaves.push('history');
    } catch (error) {
      console.error('[MemoryStore] History save failed:', error);
    }
    
    // SAVE 2: Latest with aggregated context (48 hours TTL)
    try {
      const latestEntry = {
        ...memoryEntry,
        behavioral_score: behavioralScore,
        history_count: history.length,
        aggregated_context: aggregatedContext,
        last_3_summaries: last3Summaries
      };
      
      await env.CALL_MEMORIES.put(
        `latest:${phone}`,
        JSON.stringify(latestEntry),
        { expirationTtl: 48 * 60 * 60 }
      );
      redundancySaves.push('latest');
    } catch (error) {
      console.error('[MemoryStore] Latest save failed:', error);
    }
    
    // SAVE 3: Phone backup with digits only (for fallback lookup)
    try {
      const digitsOnly = phone.replace(/\D/g, '');
      const last10 = digitsOnly.slice(-10);
      
      // Save pointer to the E.164 phone
      await env.CALL_MEMORIES.put(
        `phone_index:${last10}`,
        JSON.stringify({
          canonical_phone: phone,
          timestamp: now.toISOString()
        }),
        { expirationTtl: 7 * 24 * 60 * 60 }
      );
      redundancySaves.push('phone_index');
    } catch (error) {
      console.error('[MemoryStore] Phone index save failed:', error);
    }
    
    const processingTime = Date.now() - startTime;
    
    console.log(`[MemoryStore] ✅ SUCCESS: ${phone} - ${history.length} entries in ${processingTime}ms`);

    return jsonResponse({
      ok: true,
      phone: phone,
      stored: true,
      entries_count: history.length,
      behavioral_score: behavioralScore,
      aggregated_context: {
        preferred_name: aggregatedContext.preferred_name,
        preferred_language: aggregatedContext.preferred_language,
        preferred_pickup_address: aggregatedContext.preferred_pickup_address
      },
      last_3_summaries: last3Summaries,
      processing_time_ms: processingTime,
      redundancy_saves: redundancySaves,
      warnings: warnings.length > 0 ? warnings : undefined
    });

  } catch (error) {
    console.error('[MemoryStore] Critical error:', error);
    return jsonResponse({ 
      ok: false, 
      error: 'STORE_FAILED',
      message: error.message 
    }, 500);
  }
}

// ============================================================================
// PHONE EXTRACTION - COMPREHENSIVE (MATCHES LOOKUP-MASTER)
// ============================================================================

function extractPhoneComprehensive(body, request) {
  // Priority order - check all possible Vapi locations
  const sources = [
    // Direct body (Vapi tool call format)
    body.phone,
    body.phone_backup,
    body.phone_emergency,
    
    // Vapi message structure
    body.message?.artifact?.phone,
    body.message?.call?.customer?.number,
    body.message?.call?.customer?.phone,
    body.message?.phone,
    
    // Direct call structure
    body.call?.customer?.number,
    body.call?.customer?.phone,
    body.call?.phoneNumber,
    
    // Customer structure
    body.customer?.number,
    body.customer?.phone,
    
    // Artifact structure
    body.artifact?.phone,
    
    // Analysis structure
    body.analysis?.structuredData?.phone,
    body.message?.analysis?.structuredData?.phone,
    
    // Properties
    body.properties?.phone,
    
    // Headers
    request.headers.get('x-vapi-customer-number'),
    request.headers.get('x-customer-number'),
    request.headers.get('x-caller-number'),
    request.headers.get('phone')
  ];

  for (const source of sources) {
    if (source && String(source).trim().length >= 7) {
      const digits = String(source).replace(/\D/g, '');
      if (digits.length >= 10) {
        console.log(`[MemoryStore] Phone found: ${source}`);
        return source;
      }
    }
  }

  // Deep search as fallback
  return deepPhoneSearch(body, '', new Set());
}

function deepPhoneSearch(obj, path, visited) {
  if (!obj || typeof obj !== 'object') return null;
  if (visited.has(obj)) return null;
  visited.add(obj);
  
  const phoneKeys = ['phone', 'number', 'phoneNumber', 'caller', 'from', 'customer_number'];
  
  for (const [key, value] of Object.entries(obj)) {
    if (phoneKeys.some(pk => key.toLowerCase().includes(pk))) {
      if (typeof value === 'string' && value.replace(/\D/g, '').length >= 10) {
        console.log(`[MemoryStore] Deep search found phone at ${path}.${key}`);
        return value;
      }
    }
    
    if (typeof value === 'object' && value !== null) {
      const found = deepPhoneSearch(value, `${path}.${key}`, visited);
      if (found) return found;
    }
  }
  
  return null;
}

// ============================================================================
// PHONE NORMALIZATION - E.164 FORMAT (CONSISTENT WITH LOOKUP-MASTER)
// ============================================================================

function normalizePhone(input) {
  if (!input) return null;
  
  let digits = String(input).replace(/\D/g, '');
  
  // 10 digits: assume US
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // 11 digits starting with 1: US with country code
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  // 12+ digits starting with 001: iCabbi format
  if (digits.length >= 12 && digits.startsWith('001')) {
    return `+${digits.slice(2)}`;
  }
  
  // Already has + prefix
  if (String(input).startsWith('+')) {
    return input;
  }
  
  return digits.length >= 10 ? `+${digits}` : null;
}

// ============================================================================
// MEMORY RETRIEVAL HELPER
// ============================================================================

async function getExistingMemory(phone, env) {
  try {
    // Try primary format first
    let latestStr = await env.CALL_MEMORIES.get(`latest:${phone}`);
    
    if (latestStr) {
      return JSON.parse(latestStr);
    }
    
    // Try phone index fallback
    const digits = phone.replace(/\D/g, '');
    const last10 = digits.slice(-10);
    const indexStr = await env.CALL_MEMORIES.get(`phone_index:${last10}`);
    
    if (indexStr) {
      const index = JSON.parse(indexStr);
      latestStr = await env.CALL_MEMORIES.get(`latest:${index.canonical_phone}`);
      if (latestStr) {
        console.log(`[MemoryStore] Found via phone_index: ${index.canonical_phone}`);
        return JSON.parse(latestStr);
      }
    }
    
    return null;
  } catch (error) {
    console.error('[MemoryStore] Get existing memory error:', error);
    return null;
  }
}

// ============================================================================
// AGGREGATED CONTEXT BUILDER (3-CONVERSATION PRIORITY)
// ============================================================================

function buildAggregatedContext(history) {
  if (!history || history.length === 0) return {};
  
  // Take last 5 most recent calls for analysis
  const recentCalls = history.slice(0, 5);
  
  // PRIORITY: Most recent preferred_name wins
  let preferred_name = null;
  for (const call of recentCalls) {
    if (call.preferred_name) {
      preferred_name = call.preferred_name;
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
  
  // PRIORITY: Most recent explicit preferred pickup
  let preferred_pickup_address = null;
  for (const call of recentCalls) {
    if (call.preferred_pickup_address) {
      preferred_pickup_address = call.preferred_pickup_address;
      break;
    }
  }
  
  // If no explicit preferred, check for address pattern (2+ uses)
  if (!preferred_pickup_address) {
    const addressCounts = {};
    
    for (const call of history) {
      if (call.last_pickup) {
        const addr = call.last_pickup.trim();
        if (addr) {
          addressCounts[addr] = (addressCounts[addr] || 0) + 1;
        }
      }
      if (call.collected_info?.pickup_address) {
        const addr = call.collected_info.pickup_address.trim();
        if (addr) {
          addressCounts[addr] = (addressCounts[addr] || 0) + 1;
        }
      }
    }
    
    // Find most used (if 2+ times = pattern)
    let maxCount = 0;
    for (const [addr, count] of Object.entries(addressCounts)) {
      if (count >= 2 && count > maxCount) {
        maxCount = count;
        preferred_pickup_address = addr;
      }
    }
  }
  
  // Collect conversation topics
  const all_topics = new Set();
  recentCalls.forEach(call => {
    if (call.conversation_topics && Array.isArray(call.conversation_topics)) {
      call.conversation_topics.forEach(t => all_topics.add(t));
    }
  });
  
  // Collect jokes (last 3)
  const all_jokes = [];
  recentCalls.forEach(call => {
    if (call.jokes_shared) {
      if (Array.isArray(call.jokes_shared)) {
        all_jokes.push(...call.jokes_shared);
      } else if (typeof call.jokes_shared === 'string') {
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
  
  // Calculate behavioral pattern
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

// ============================================================================
// LAST 3 SUMMARIES BUILDER
// ============================================================================

function buildLast3Summaries(history) {
  if (!history || history.length === 0) return [];
  
  return history.slice(0, 3).map(call => {
    let summary = call.summary || call.outcome || 'call';
    
    // Build rich summary if we have pickup/dropoff
    if (call.last_pickup && call.last_dropoff) {
      summary = `${call.outcome || 'ride'}: ${call.last_pickup} → ${call.last_dropoff}`;
    }
    
    return {
      phone: call.phone,  // CRITICAL: Include phone
      timestamp: call.timestamp,
      summary: summary,
      outcome: call.outcome,
      behavior: call.behavior,
      was_dropped: call.was_dropped || false,
      preferred_name: call.preferred_name  // Include name if captured
    };
  });
}

// ============================================================================
// BEHAVIORAL SCORE CALCULATOR
// ============================================================================

function calculateBehavioralScore(history) {
  if (!history || history.length === 0) return 0;
  
  const weights = {
    'polite': 2, 'friendly': 2, 'grateful': 2,
    'neutral': 0,
    'impatient': -1, 'rude': -3, 'inappropriate': -5, 'abusive': -5,
    'confused': 0, 'intoxicated': -1
  };
  
  let totalScore = 0;
  let totalWeight = 0;
  
  history.forEach((entry, index) => {
    // More recent calls have higher weight
    const recencyWeight = Math.max(1, 5 - index);
    const behaviorScore = weights[entry.behavior] || 0;
    totalScore += behaviorScore * recencyWeight;
    totalWeight += recencyWeight;
  });
  
  return totalWeight > 0 ? Math.round((totalScore / totalWeight) * 10) / 10 : 0;
}

// ============================================================================
// JSON RESPONSE HELPER
// ============================================================================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}