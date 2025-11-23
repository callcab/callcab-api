// /pages/api/icabbi-api.js
// Comprehensive iCabbi API Integration for High Mountain Taxi
// Handles bookings, journeys, customers, drivers, payments, and real-time tracking

// Disable Next.js body parsing so we can handle it ourselves
export const config = {
  api: {
    bodyParser: true, // Enable automatic JSON parsing
  },
};

export default async function handler(req, res) {
  // CORS headers
  const ALLOW_ORIGIN = '*';
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }

  try {
    // Log for debugging
    console.log('[icabbi-api] Request body:', req.body);
    console.log('[icabbi-api] Request headers:', req.headers);

    // Check if body exists
    if (!req.body) {
      return res.status(400).json({
        ok: false,
        error: 'NO_BODY',
        details: 'Request body is required. Make sure Content-Type is application/json',
        headers_received: req.headers
      });
    }

    let { action, ...params } = req.body;

    // Map Vapi.ai tool names to actions
    const toolNameMap = {
      'check_caller_and_get_customer': 'getCustomerByPhone',
      'create_customer': 'createCustomer',
      'create_booking': 'createBooking',
      'get_ride_status': 'getJourneyStatus',
      'get_trip_history': 'getCustomerHistory',
      'update_booking': 'updateBooking',
      'cancel_booking': 'cancelBooking',
      'get_driver_location': 'getDriverLocation',
      'check_driver_availability': 'getAvailableDrivers'
    };

    // Check if this is a Vapi tool call (has tool name instead of action)
    if (!action) {
      // Try to find action from known tool patterns
      const possibleToolName = Object.keys(params).find(key => toolNameMap[key]);
      if (possibleToolName) {
        action = toolNameMap[possibleToolName];
      } else {
        return res.status(400).json({ 
          ok: false, 
          error: 'MISSING_ACTION',
          details: 'action parameter is required',
          received_body: req.body
        });
      }
    }

    console.log(`[icabbi-api] Action: ${action}, Params:`, JSON.stringify(params, null, 2));

    // Route to appropriate handler
    switch (action) {
      // Health Check (no iCabbi needed)
      case 'healthCheck':
      case 'health':
        return res.status(200).json({
          ok: true,
          message: 'iCabbi API endpoint is working',
          timestamp: new Date().toISOString(),
          env_check: {
            has_icabbi_app_key: !!process.env.ICABBI_APP_KEY,
            has_icabbi_secret_key: !!process.env.ICABBI_SECRET_KEY,
            has_google_maps_key: !!process.env.GOOGLE_MAPS_API_KEY,
            icabbi_base_url: process.env.ICABBI_BASE_URL || 'https://api.icabbi.com/v2'
          }
        });

      // Customer Management
      case 'getCustomerByPhone':
        return await getCustomerByPhone(params, res);
      case 'getCustomerHistory':
        return await getCustomerHistory(params, res);
      case 'createCustomer':
        return await createCustomer(params, res);
      case 'updateCustomer':
        return await updateCustomer(params, res);

      // Booking Management
      case 'createBooking':
        return await createBooking(params, res);
      case 'getBooking':
        return await getBooking(params, res);
      case 'updateBooking':
        return await updateBooking(params, res);
      case 'cancelBooking':
        return await cancelBooking(params, res);
      case 'getActiveBookings':
        return await getActiveBookings(params, res);

      // Journey/Trip Tracking
      case 'getJourney':
        return await getJourney(params, res);
      case 'getAllJourneys':
        return await getAllJourneys(params, res);
      case 'deleteJourney':
        return await deleteJourney(params, res);
      case 'getJourneyStatus':
        return await getJourneyStatus(params, res);

      // Driver Management
      case 'getAvailableDrivers':
        return await getAvailableDrivers(params, res);
      case 'getDriverLocation':
        return await getDriverLocation(params, res);
      case 'assignDriver':
        return await assignDriver(params, res);

      // Payment Management
      case 'addPayment':
        return await addPayment(params, res);
      case 'getPaymentStatus':
        return await getPaymentStatus(params, res);

      // Zone Management
      case 'getZones':
        return await getZones(params, res);
      case 'checkAvailability':
        return await checkZoneAvailability(params, res);

      // Dispatch ETA (iCabbi-first with Google fallback)
      case 'getDispatchETA':
        return await getDispatchETA(params, res);

      default:
        return res.status(400).json({
          ok: false,
          error: 'INVALID_ACTION',
          details: `Action '${action}' is not supported`,
          available_actions: [
            'getCustomerByPhone', 'getCustomerHistory', 'createCustomer', 'updateCustomer',
            'createBooking', 'getBooking', 'updateBooking', 'cancelBooking', 'getActiveBookings',
            'getJourney', 'getAllJourneys', 'deleteJourney', 'getJourneyStatus',
            'getAvailableDrivers', 'getDriverLocation', 'assignDriver',
            'addPayment', 'getPaymentStatus',
            'getZones', 'checkAvailability',
            'getDispatchETA'
          ]
        });
    }
  } catch (err) {
    console.error('[icabbi-api] error:', err);
    return res.status(500).json({
      ok: false,
      error: 'ICABBI_API_ERROR',
      message: err?.message || 'Unknown error'
    });
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Make authenticated request to iCabbi API
 */
async function makeIcabbiRequest(endpoint, method = 'POST', body = null) {
  const appKey = process.env.ICABBI_APP_KEY;
  const secretKey = process.env.ICABBI_SECRET_KEY;
  const baseUrl = process.env.ICABBI_BASE_URL || 'https://api.icabbi.com/v2';

  if (!appKey || !secretKey) {
    throw new Error('iCabbi API credentials not configured');
  }

  const url = `${baseUrl}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-App-Key': appKey,
      'X-Secret-Key': secretKey
    }
  };

  if (body && (method === 'POST' || method === 'PUT')) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  console.log('[makeIcabbiRequest]', endpoint, 'Response:', JSON.stringify(data, null, 2));

  // iCabbi returns code in the response body, not just HTTP status
  if (!response.ok) {
    console.error('[makeIcabbiRequest] HTTP error:', response.status);
    throw new Error(`HTTP ${response.status}: ${data.body?.message || 'Request failed'}`);
  }

  // Check iCabbi's response code (they use 200 for success, 404 for not found, etc.)
  if (data.code && data.code !== 200 && data.code !== '200') {
    console.error('[makeIcabbiRequest] iCabbi error code:', data.code, 'Body:', data.body);
    
    // If it's a 404, handle it specially (customer not found is not really an error)
    if (data.code === 404 || data.code === '404') {
      throw new Error('NOT_FOUND');
    }
    
    throw new Error(data.body?.message || data.warnings?.[0] || `iCabbi error code: ${data.code}`);
  }

  return data;
}

/**
 * Format phone number for iCabbi
 */
function formatPhoneForIcabbi(phone) {
  // Remove all non-digits
  const digits = phone.replace(/\D/g, '');
  
  // If it's 10 digits, assume US and add +1
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  
  // If it's 11 digits and starts with 1, add +
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  
  return `+${digits}`;
}

/**
 * Parse iCabbi timestamp to readable format
 */
function parseIcabbiTime(timestamp) {
  if (!timestamp) return null;
  const date = new Date(parseInt(timestamp) * 1000);
  return date.toISOString();
}

/**
 * Format time for voice (America/Denver timezone)
 */
function formatTimeForVoice(timestamp) {
  if (!timestamp) return null;
  const date = new Date(parseInt(timestamp) * 1000);
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Denver'
  }).format(date);
}

// ============================================================================
// CUSTOMER MANAGEMENT
// ============================================================================

/**
 * Get customer information by phone number
 * Returns: customer details, booking history, account status
 */
async function getCustomerByPhone(params, res) {
  const { phone, caller_number } = params;

  // Use caller_number if phone not provided (for automatic caller ID lookup)
  const phoneToUse = phone || caller_number;

  console.log('[getCustomerByPhone] Looking up phone:', phoneToUse);

  if (!phoneToUse) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_PHONE',
      details: 'phone or caller_number parameter is required'
    });
  }

  try {
    const formattedPhone = formatPhoneForIcabbi(phoneToUse);
    console.log('[getCustomerByPhone] Formatted phone:', formattedPhone);
    
    const data = await makeIcabbiRequest('/customer/get', 'POST', {
      phone: formattedPhone
    });

    const customer = data.body?.customer || {};

    if (!customer.id) {
      // Customer doesn't exist
      console.log('[getCustomerByPhone] Customer not found');
      return res.status(200).json({
        ok: true,
        customer_exists: false,
        phone: formattedPhone,
        message: 'Customer not found - ready to create new customer'
      });
    }

    console.log('[getCustomerByPhone] Customer found:', customer.id);

    return res.status(200).json({
      ok: true,
      customer_exists: true,
      customer_id: customer.id,
      name: customer.name || null,
      phone: customer.phone || formattedPhone,
      email: customer.email || null,
      account_type: customer.account_type || 'standard',
      account_number: customer.account_number || null,
      payment_method: customer.default_payment_method || null,
      loyalty_points: customer.loyalty_points || 0,
      total_rides: customer.total_bookings || 0,
      notes: customer.notes || null,
      created_at: parseIcabbiTime(customer.ts_created)
    });
  } catch (err) {
    console.error('[getCustomerByPhone] Error:', err);
    // If customer doesn't exist, return empty result (not an error)
    if (err.message === 'NOT_FOUND' || err.message.includes('not found') || err.message.includes('404')) {
      return res.status(200).json({
        ok: true,
        customer_exists: false,
        phone: formatPhoneForIcabbi(phoneToUse),
        message: 'Customer not found - ready to create new customer'
      });
    }
    
    // Actual error
    return res.status(500).json({
      ok: false,
      error: 'LOOKUP_FAILED',
      message: err.message,
      details: 'Failed to lookup customer in iCabbi'
    });
  }
}

/**
 * Get customer booking history
 */
async function getCustomerHistory(params, res) {
  const { customer_id, phone, limit = 10 } = params;

  try {
    const data = await makeIcabbiRequest('/booking/history', 'POST', {
      customer_id: customer_id || undefined,
      phone: phone ? formatPhoneForIcabbi(phone) : undefined,
      limit: parseInt(limit)
    });

    const bookings = data.body?.bookings || [];

    const formattedBookings = bookings.map(booking => ({
      booking_id: booking.id,
      journey_id: booking.journey_id,
      pickup_address: booking.pickup_address,
      dropoff_address: booking.dropoff_address,
      pickup_time: formatTimeForVoice(booking.pickup_time),
      status: booking.status,
      fare: booking.fare ? parseFloat(booking.fare) : null,
      driver_name: booking.driver_name || null,
      date: parseIcabbiTime(booking.ts_created)
    }));

    return res.status(200).json({
      ok: true,
      total_bookings: bookings.length,
      bookings: formattedBookings,
      last_booking: formattedBookings[0] || null
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      total_bookings: 0,
      bookings: [],
      message: 'No booking history found'
    });
  }
}

/**
 * Create new customer
 */
async function createCustomer(params, res) {
  const { name, phone, email, notes, customer_name, customer_phone } = params;

  // Allow both name/phone and customer_name/customer_phone parameter names
  const finalName = name || customer_name;
  const finalPhone = phone || customer_phone;

  console.log('[createCustomer] Received params:', JSON.stringify(params, null, 2));

  if (!finalName || !finalPhone) {
    console.error('[createCustomer] Missing required fields:', { finalName, finalPhone });
    return res.status(400).json({
      ok: false,
      error: 'MISSING_REQUIRED_FIELDS',
      details: 'name and phone are required',
      received_params: params
    });
  }

  try {
    const formattedPhone = formatPhoneForIcabbi(finalPhone);
    
    const data = await makeIcabbiRequest('/customer/create', 'POST', {
      name: finalName,
      phone: formattedPhone,
      email: email || undefined,
      notes: notes || undefined
    });

    const customer = data.body?.customer || {};

    return res.status(200).json({
      ok: true,
      customer_id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      message: 'Customer created successfully'
    });
  } catch (err) {
    console.error('[createCustomer] Error:', err);
    return res.status(500).json({
      ok: false,
      error: 'CREATE_CUSTOMER_FAILED',
      message: err.message
    });
  }
}

/**
 * Update customer information
 */
async function updateCustomer(params, res) {
  const { customer_id, phone, name, email, notes } = params;

  if (!customer_id && !phone) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_IDENTIFIER',
      details: 'customer_id or phone is required'
    });
  }

  const data = await makeIcabbiRequest('/customer/update', 'POST', {
    customer_id: customer_id || undefined,
    phone: phone ? formatPhoneForIcabbi(phone) : undefined,
    name: name || undefined,
    email: email || undefined,
    notes: notes || undefined
  });

  return res.status(200).json({
    ok: true,
    message: 'Customer updated successfully',
    customer: data.body?.customer
  });
}

// ============================================================================
// BOOKING MANAGEMENT
// ============================================================================

/**
 * Create new booking in iCabbi
 */
async function createBooking(params, res) {
  const {
    customer_name,
    customer_phone,
    customer_id,
    pickup_lat,
    pickup_lng,
    pickup_address,
    dropoff_lat,
    dropoff_lng,
    dropoff_address,
    pickup_time, // ISO string or 'now'
    passengers = 1,
    luggage = 0,
    notes,
    vehicle_type,
    payment_method,
    estimated_fare,
    is_asap = true
  } = params;

  // Validate required fields
  if (!customer_phone && !customer_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_CUSTOMER',
      details: 'customer_phone or customer_id is required'
    });
  }

  if (!pickup_lat || !pickup_lng || !dropoff_lat || !dropoff_lng) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_COORDINATES',
      details: 'pickup and dropoff coordinates are required'
    });
  }

  // Calculate pickup timestamp
  let pickupTimestamp;
  if (is_asap || pickup_time === 'now') {
    pickupTimestamp = Math.floor(Date.now() / 1000);
  } else {
    pickupTimestamp = Math.floor(new Date(pickup_time).getTime() / 1000);
  }

  const bookingData = {
    customer: {
      id: customer_id || undefined,
      name: customer_name || undefined,
      phone: customer_phone ? formatPhoneForIcabbi(customer_phone) : undefined
    },
    pickup: {
      lat: parseFloat(pickup_lat),
      lng: parseFloat(pickup_lng),
      address: pickup_address,
      timestamp: pickupTimestamp
    },
    dropoff: {
      lat: parseFloat(dropoff_lat),
      lng: parseFloat(dropoff_lng),
      address: dropoff_address
    },
    passengers: parseInt(passengers),
    luggage: parseInt(luggage),
    notes: notes || undefined,
    vehicle_type: vehicle_type || 'standard',
    payment_method: payment_method || 'cash',
    estimated_fare: estimated_fare ? parseFloat(estimated_fare) : undefined,
    asap: is_asap
  };

  const data = await makeIcabbiRequest('/booking/create', 'POST', bookingData);

  const booking = data.body?.booking || {};
  const journey = data.body?.journey || {};

  return res.status(200).json({
    ok: true,
    booking_id: booking.id,
    journey_id: journey.id,
    booking_ref: booking.reference_number || booking.id,
    status: booking.status || 'NEW',
    pickup_time: formatTimeForVoice(pickupTimestamp),
    estimated_arrival: booking.estimated_arrival ? formatTimeForVoice(booking.estimated_arrival) : null,
    driver_assigned: !!booking.driver_id,
    driver_id: booking.driver_id || null,
    driver_name: booking.driver_name || null,
    vehicle_number: booking.vehicle_number || null,
    message: 'Booking created successfully'
  });
}

/**
 * Get booking details
 */
async function getBooking(params, res) {
  const { booking_id, reference_number } = params;

  if (!booking_id && !reference_number) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_IDENTIFIER',
      details: 'booking_id or reference_number is required'
    });
  }

  const data = await makeIcabbiRequest('/booking/get', 'POST', {
    booking_id: booking_id || undefined,
    reference: reference_number || undefined
  });

  const booking = data.body?.booking || {};

  return res.status(200).json({
    ok: true,
    booking_id: booking.id,
    journey_id: booking.journey_id,
    reference_number: booking.reference_number,
    status: booking.status,
    customer_name: booking.customer_name,
    customer_phone: booking.customer_phone,
    pickup_address: booking.pickup_address,
    dropoff_address: booking.dropoff_address,
    pickup_time: formatTimeForVoice(booking.pickup_time),
    driver_id: booking.driver_id,
    driver_name: booking.driver_name,
    driver_phone: booking.driver_phone,
    vehicle_number: booking.vehicle_number,
    estimated_fare: booking.estimated_fare ? parseFloat(booking.estimated_fare) : null,
    actual_fare: booking.actual_fare ? parseFloat(booking.actual_fare) : null,
    passengers: booking.passengers,
    luggage: booking.luggage,
    notes: booking.notes,
    created_at: parseIcabbiTime(booking.ts_created),
    updated_at: parseIcabbiTime(booking.ts_updated)
  });
}

/**
 * Update existing booking
 */
async function updateBooking(params, res) {
  const {
    booking_id,
    pickup_time,
    passengers,
    luggage,
    notes,
    status
  } = params;

  if (!booking_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_BOOKING_ID',
      details: 'booking_id is required'
    });
  }

  const updateData = {
    booking_id: parseInt(booking_id)
  };

  if (pickup_time) {
    updateData.pickup_time = Math.floor(new Date(pickup_time).getTime() / 1000);
  }
  if (passengers !== undefined) updateData.passengers = parseInt(passengers);
  if (luggage !== undefined) updateData.luggage = parseInt(luggage);
  if (notes !== undefined) updateData.notes = notes;
  if (status) updateData.status = status;

  const data = await makeIcabbiRequest('/booking/update', 'POST', updateData);

  return res.status(200).json({
    ok: true,
    booking_id: booking_id,
    message: 'Booking updated successfully',
    booking: data.body?.booking
  });
}

/**
 * Cancel booking
 */
async function cancelBooking(params, res) {
  const { booking_id, reason } = params;

  if (!booking_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_BOOKING_ID',
      details: 'booking_id is required'
    });
  }

  const data = await makeIcabbiRequest('/booking/cancel', 'POST', {
    booking_id: parseInt(booking_id),
    reason: reason || 'Customer requested cancellation'
  });

  return res.status(200).json({
    ok: true,
    booking_id: booking_id,
    status: 'CANCELLED',
    message: 'Booking cancelled successfully'
  });
}

/**
 * Get all active bookings
 */
async function getActiveBookings(params, res) {
  const { limit = 20, offset = 0 } = params;

  const data = await makeIcabbiRequest('/booking/active', 'POST', {
    limit: parseInt(limit),
    offset: parseInt(offset)
  });

  const bookings = data.body?.bookings || [];

  const formattedBookings = bookings.map(booking => ({
    booking_id: booking.id,
    journey_id: booking.journey_id,
    reference_number: booking.reference_number,
    status: booking.status,
    customer_name: booking.customer_name,
    pickup_address: booking.pickup_address,
    dropoff_address: booking.dropoff_address,
    pickup_time: formatTimeForVoice(booking.pickup_time),
    driver_assigned: !!booking.driver_id,
    driver_name: booking.driver_name || null
  }));

  return res.status(200).json({
    ok: true,
    total: formattedBookings.length,
    bookings: formattedBookings
  });
}

// ============================================================================
// JOURNEY/TRIP TRACKING
// ============================================================================

/**
 * Get journey details (real-time trip tracking)
 */
async function getJourney(params, res) {
  const { journey_id, booking_id } = params;

  if (!journey_id && !booking_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_IDENTIFIER',
      details: 'journey_id or booking_id is required'
    });
  }

  const data = await makeIcabbiRequest('/journey/get', 'POST', {
    journey_id: journey_id ? parseInt(journey_id) : undefined,
    booking_id: booking_id ? parseInt(booking_id) : undefined
  });

  const journey = data.body?.journey || [];
  const payment = data.body?.payment || [];

  // Parse journey segments
  const segments = journey.map(segment => ({
    id: segment.id,
    journey_id: segment.journey_id,
    booking_id: segment.booking_id,
    is_destination: segment.is_destination === '1',
    order: parseInt(segment.order),
    status: segment.status,
    planned_time: formatTimeForVoice(segment.planned_date),
    distance_meters: parseInt(segment.distance)
  }));

  // Get current segment (lowest order with NEW status)
  const currentSegment = segments.find(s => s.status === 'NEW') || segments[0];

  // Parse payment info
  const paymentInfo = payment[0] || {};

  return res.status(200).json({
    ok: true,
    journey_id: segments[0]?.journey_id,
    segments: segments,
    current_segment: currentSegment,
    total_segments: segments.length,
    status: currentSegment?.status || 'UNKNOWN',
    payment: {
      cost: paymentInfo.cost ? parseFloat(paymentInfo.cost) : null,
      price: paymentInfo.price ? parseFloat(paymentInfo.price) : null
    },
    enable_messaging: data.body?.enable_messaging_service || false
  });
}

/**
 * Get all active journeys
 */
async function getAllJourneys(params, res) {
  const { limit = 20, offset = 0 } = params;

  const data = await makeIcabbiRequest('/journey/index', 'POST', {
    limit: parseInt(limit),
    offset: parseInt(offset)
  });

  const journeys = data.body?.journeys || {};
  const total = data.body?.total || 0;
  const totalAvailable = data.body?.total_available || 0;

  const formattedJourneys = Object.entries(journeys).map(([journeyId, segments]) => {
    const firstSegment = segments[0] || {};
    return {
      journey_id: journeyId,
      segments_count: segments.length,
      driver_id: firstSegment.driver_id || null,
      driver_assigned: firstSegment.driver_id && firstSegment.driver_id !== '0',
      booking_id: firstSegment.booking_id,
      status: firstSegment.status,
      planned_time: formatTimeForVoice(firstSegment.planned_date)
    };
  });

  return res.status(200).json({
    ok: true,
    total: total,
    total_available: totalAvailable,
    journeys: formattedJourneys
  });
}

/**
 * Delete journey (cancel trip)
 */
async function deleteJourney(params, res) {
  const { journey_id } = params;

  if (!journey_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_JOURNEY_ID',
      details: 'journey_id is required'
    });
  }

  const data = await makeIcabbiRequest('/journey/delete', 'POST', {
    journey_id: parseInt(journey_id)
  });

  return res.status(200).json({
    ok: true,
    journey_id: journey_id,
    deleted_bookings: data.body?.delete_bookings_count || 0,
    deleted_segments: data.body?.delete_segments_count || 0,
    message: 'Journey deleted successfully'
  });
}

/**
 * Get journey status (for caller updates)
 */
async function getJourneyStatus(params, res) {
  const { journey_id, booking_id, phone } = params;

  try {
    // First try to get journey by ID
    let journeyData;
    if (journey_id || booking_id) {
      journeyData = await makeIcabbiRequest('/journey/get', 'POST', {
        journey_id: journey_id ? parseInt(journey_id) : undefined,
        booking_id: booking_id ? parseInt(booking_id) : undefined
      });
    } else if (phone) {
      // Look up customer's most recent booking
      const customerData = await makeIcabbiRequest('/booking/history', 'POST', {
        phone: formatPhoneForIcabbi(phone),
        limit: 1
      });
      
      const recentBooking = customerData.body?.bookings?.[0];
      if (recentBooking && recentBooking.journey_id) {
        journeyData = await makeIcabbiRequest('/journey/get', 'POST', {
          journey_id: parseInt(recentBooking.journey_id)
        });
      }
    }

    if (!journeyData) {
      return res.status(404).json({
        ok: false,
        error: 'JOURNEY_NOT_FOUND',
        message: 'No active journey found'
      });
    }

    const journey = journeyData.body?.journey || [];
    const currentSegment = journey.find(s => s.status === 'NEW') || journey[0];

    // Determine status message for caller
    let statusMessage = '';
    let eta = null;

    switch (currentSegment?.status) {
      case 'NEW':
        if (currentSegment.driver_id && currentSegment.driver_id !== '0') {
          statusMessage = 'Your driver is on the way';
          eta = formatTimeForVoice(currentSegment.planned_date);
        } else {
          statusMessage = 'We are finding a driver for you';
        }
        break;
      case 'ACCEPTED':
        statusMessage = 'Driver has accepted your ride';
        eta = formatTimeForVoice(currentSegment.planned_date);
        break;
      case 'ARRIVED':
        statusMessage = 'Your driver has arrived';
        break;
      case 'PICKED_UP':
        statusMessage = 'You are currently on your ride';
        break;
      case 'COMPLETED':
        statusMessage = 'Your ride is complete';
        break;
      default:
        statusMessage = 'Checking on your ride';
    }

    return res.status(200).json({
      ok: true,
      journey_id: currentSegment?.journey_id,
      booking_id: currentSegment?.booking_id,
      status: currentSegment?.status,
      status_message: statusMessage,
      driver_assigned: currentSegment?.driver_id && currentSegment.driver_id !== '0',
      driver_id: currentSegment?.driver_id || null,
      estimated_arrival: eta,
      message_for_caller: `${statusMessage}${eta ? `, estimated arrival ${eta}` : ''}`
    });
  } catch (err) {
    return res.status(200).json({
      ok: false,
      error: 'NO_ACTIVE_JOURNEY',
      message: 'No active ride found for this request'
    });
  }
}

// ============================================================================
// DRIVER MANAGEMENT
// ============================================================================

/**
 * Get available drivers in area
 */
async function getAvailableDrivers(params, res) {
  const { lat, lng, radius_meters = 5000 } = params;

  if (!lat || !lng) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_COORDINATES',
      details: 'lat and lng are required'
    });
  }

  const data = await makeIcabbiRequest('/driver/available', 'POST', {
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    radius: parseInt(radius_meters)
  });

  const drivers = data.body?.drivers || [];

  const formattedDrivers = drivers.map(driver => ({
    driver_id: driver.id,
    name: driver.name,
    vehicle_number: driver.vehicle_number,
    distance_meters: driver.distance,
    distance_miles: Math.round((driver.distance / 1609.344) * 10) / 10,
    available: driver.available === '1',
    status: driver.status
  }));

  return res.status(200).json({
    ok: true,
    drivers_available: formattedDrivers.length,
    drivers: formattedDrivers,
    closest_driver: formattedDrivers[0] || null
  });
}

/**
 * Get driver location (real-time)
 */
async function getDriverLocation(params, res) {
  const { driver_id } = params;

  if (!driver_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_DRIVER_ID',
      details: 'driver_id is required'
    });
  }

  const data = await makeIcabbiRequest('/driver/location', 'POST', {
    driver_id: parseInt(driver_id)
  });

  const location = data.body?.location || {};

  return res.status(200).json({
    ok: true,
    driver_id: driver_id,
    lat: location.lat ? parseFloat(location.lat) : null,
    lng: location.lng ? parseFloat(location.lng) : null,
    heading: location.heading || null,
    speed: location.speed || null,
    timestamp: parseIcabbiTime(location.timestamp)
  });
}

/**
 * Assign driver to booking
 */
async function assignDriver(params, res) {
  const { booking_id, driver_id } = params;

  if (!booking_id || !driver_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_PARAMETERS',
      details: 'booking_id and driver_id are required'
    });
  }

  const data = await makeIcabbiRequest('/booking/assignDriver', 'POST', {
    booking_id: parseInt(booking_id),
    driver_id: parseInt(driver_id)
  });

  return res.status(200).json({
    ok: true,
    booking_id: booking_id,
    driver_id: driver_id,
    message: 'Driver assigned successfully'
  });
}

// ============================================================================
// PAYMENT MANAGEMENT
// ============================================================================

/**
 * Add payment to journey
 */
async function addPayment(params, res) {
  const { journey_id, amount, payment_type = 'cash', is_fixed_price = false } = params;

  if (!journey_id || !amount) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_PARAMETERS',
      details: 'journey_id and amount are required'
    });
  }

  const data = await makeIcabbiRequest('/journey/addPaymentBooking', 'POST', {
    journey_id: parseInt(journey_id),
    payment: {
      fixed: is_fixed_price ? 1 : 0,
      price: parseFloat(amount),
      cost: parseFloat(amount)
    }
  });

  return res.status(200).json({
    ok: true,
    journey_id: journey_id,
    amount: parseFloat(amount),
    payment_type: payment_type,
    message: 'Payment recorded successfully'
  });
}

/**
 * Get payment status for journey
 */
async function getPaymentStatus(params, res) {
  const { journey_id } = params;

  if (!journey_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_JOURNEY_ID',
      details: 'journey_id is required'
    });
  }

  const data = await makeIcabbiRequest('/journey/get', 'POST', {
    journey_id: parseInt(journey_id)
  });

  const payment = data.body?.payment?.[0] || {};

  return res.status(200).json({
    ok: true,
    journey_id: journey_id,
    payment_received: !!payment.id,
    amount: payment.price ? parseFloat(payment.price) : null,
    cost: payment.cost ? parseFloat(payment.cost) : null
  });
}

// ============================================================================
// ZONE MANAGEMENT
// ============================================================================

/**
 * Get all zones
 */
async function getZones(params, res) {
  const data = await makeIcabbiRequest('/zone', 'GET');

  const zones = data.body?.zones || [];

  const formattedZones = zones.map(zone => ({
    id: zone.id,
    ref: zone.ref,
    title: zone.title,
    lat: parseFloat(zone.lat),
    lng: parseFloat(zone.lng),
    active: zone.active === '1',
    priority: parseInt(zone.priority)
  }));

  return res.status(200).json({
    ok: true,
    zones: formattedZones
  });
}

/**
 * Check zone availability
 */
async function checkZoneAvailability(params, res) {
  const { zone_id, date_time } = params;

  if (!zone_id) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_ZONE_ID',
      details: 'zone_id is required'
    });
  }

  const data = await makeIcabbiRequest(`/zone/${zone_id}`, 'GET');

  const zone = data.body?.zones?.[0] || {};
  const fullyBookedTimes = zone.fully_booked_times || [];

  // Check if requested time falls in fully booked period
  let isAvailable = true;
  let blockedReason = null;

  if (date_time) {
    const requestedTime = new Date(date_time);
    
    for (const blockedPeriod of fullyBookedTimes) {
      const from = new Date(blockedPeriod.from);
      const to = new Date(blockedPeriod.to);
      
      if (requestedTime >= from && requestedTime <= to) {
        isAvailable = false;
        blockedReason = `Zone fully booked from ${from.toLocaleString()} to ${to.toLocaleString()}`;
        break;
      }
    }
  }

  return res.status(200).json({
    ok: true,
    zone_id: zone_id,
    zone_title: zone.title,
    available: isAvailable && zone.active === '1',
    active: zone.active === '1',
    blocked_reason: blockedReason,
    fully_booked_times: fullyBookedTimes
  });
}

/**
 * Get dispatch ETA - checks iCabbi for real driver locations first, 
 * falls back to HQ if no drivers available
 */
async function getDispatchETA(params, res) {
  const { pickup_lat, pickup_lng, pickup_address } = params;

  // Validate coordinates
  const pLat = typeof pickup_lat === 'string' ? parseFloat(pickup_lat) : pickup_lat;
  const pLng = typeof pickup_lng === 'string' ? parseFloat(pickup_lng) : pickup_lng;

  if (!pLat || !pLng || Number.isNaN(pLat) || Number.isNaN(pLng)) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_COORDS',
      details: 'pickup_lat and pickup_lng required'
    });
  }

  if (Math.abs(pLat) > 90 || Math.abs(pLng) > 180) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_COORDS',
      details: 'Coordinates out of valid range'
    });
  }

  const googleKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!googleKey) {
    return res.status(500).json({ ok: false, error: 'NO_GOOGLE_MAPS_API_KEY' });
  }

  // High Mountain Taxi base (fallback)
  const HM_BASE = {
    lat: 39.2228,
    lng: -106.8692,
    address: '214 Aspen Airport Business Ctr, Unit B, Aspen, CO 81611'
  };

  let dispatchLocation = null;
  let driversAvailable = 0;
  let driverInfo = null;

  // Try to get available drivers from iCabbi
  try {
    const data = await makeIcabbiRequest('/driver/available', 'POST', {
      lat: pLat,
      lng: pLng,
      radius: 15000 // 15km
    });

    const drivers = data.body?.drivers || [];
    driversAvailable = drivers.length;

    if (drivers.length > 0) {
      // Use closest driver
      const closest = drivers[0];
      dispatchLocation = {
        lat: parseFloat(closest.lat),
        lng: parseFloat(closest.lng)
      };
      driverInfo = {
        driver_id: closest.id,
        driver_name: closest.name,
        vehicle_number: closest.vehicle_number,
        distance_meters: closest.distance
      };
    }
  } catch (err) {
    console.warn('[getDispatchETA] iCabbi driver lookup failed:', err.message);
    // Continue with fallback
  }

  // Fallback to HQ if no drivers
  if (!dispatchLocation) {
    dispatchLocation = HM_BASE;
  }

  const dispatchAddress = driverInfo 
    ? `Driver ${driverInfo.driver_name}` 
    : HM_BASE.address;

  // Calculate ETA with Google Distance Matrix
  const params_url = new URLSearchParams({
    origins: `${dispatchLocation.lat},${dispatchLocation.lng}`,
    destinations: `${pLat},${pLng}`,
    units: 'imperial',
    mode: 'driving',
    region: 'US',
    departure_time: 'now',
    traffic_model: 'best_guess',
    key: googleKey
  });

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?${params_url.toString()}`;
  const gRes = await fetch(url);
  const data = await gRes.json();

  if (data?.status !== 'OK' || !data?.rows?.[0]?.elements?.[0]) {
    return res.status(502).json({
      ok: false,
      error: 'GOOGLE_API_ERROR',
      google_status: data?.status
    });
  }

  const element = data.rows[0].elements[0];
  if (element?.status !== 'OK') {
    return res.status(200).json({
      ok: false,
      error: 'ROUTE_NOT_FOUND',
      element_status: element?.status
    });
  }

  const durationSeconds = element.duration_in_traffic?.value ?? element.duration?.value ?? 0;
  const durationMinutes = Math.ceil(durationSeconds / 60);
  const distanceMeters = element.distance?.value ?? 0;
  const distanceMiles = Math.round((distanceMeters / 1609.344) * 10) / 10;
  const distanceText = element.distance?.text || `${distanceMiles.toFixed(1)} mi`;

  // Add prep time
  const prepTimeMinutes = 2;
  const totalEtaMinutes = durationMinutes + prepTimeMinutes;

  // Format time in America/Denver
  const ASPEN_TZ = 'America/Denver';
  const nowUtcMs = Date.now();
  const arrivalUtcMs = nowUtcMs + totalEtaMinutes * 60 * 1000;

  const fmtLocalTime = (ms, tz = ASPEN_TZ) =>
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: tz
    }).format(ms);

  const estimated_arrival_time = fmtLocalTime(arrivalUtcMs);
  const now_local_time = fmtLocalTime(nowUtcMs);

  // ETA summary buckets
  let etaSummary;
  if (totalEtaMinutes <= 5) etaSummary = 'about 5 minutes';
  else if (totalEtaMinutes <= 10) etaSummary = 'about 10 minutes';
  else if (totalEtaMinutes <= 15) etaSummary = 'about 10-15 minutes';
  else if (totalEtaMinutes <= 20) etaSummary = 'about 15-20 minutes';
  else if (totalEtaMinutes <= 30) etaSummary = 'about 20-30 minutes';
  else etaSummary = `about ${totalEtaMinutes} minutes`;

  return res.status(200).json({
    ok: true,
    dispatch_from: dispatchAddress,
    dispatch_lat: dispatchLocation.lat,
    dispatch_lng: dispatchLocation.lng,
    driver_info: driverInfo,
    drivers_available: driversAvailable,
    pickup_address: pickup_address || null,
    pickup_lat: pLat,
    pickup_lng: pLng,
    drive_time_minutes: durationMinutes,
    prep_time_minutes: prepTimeMinutes,
    total_eta_minutes: totalEtaMinutes,
    distance_miles: distanceMiles,
    distance_text: distanceText,
    timezone: ASPEN_TZ,
    now_local_time,
    estimated_arrival_time,
    eta_summary: etaSummary,
    capacity_warning: driversAvailable === 0 
      ? 'Running lean right now, might take a bit longer' 
      : null,
    source: driverInfo ? 'icabbi_driver' : 'base_location',
    calculated_at: new Date(nowUtcMs).toISOString()
  });
}
