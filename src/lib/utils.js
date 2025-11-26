// src/lib/utils.js
// CLAIRE v4.2 - Shared Utility Functions

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Create a JSON response with CORS headers
 */
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

/**
 * Normalize phone number to E.164 format
 */
export function normalizePhone(input) {
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
  
  // Already has + prefix
  if (String(input).startsWith('+')) {
    return input;
  }
  
  return digits.length >= 10 ? `+${digits}` : null;
}

/**
 * Generate multiple phone formats for fallback lookups
 */
export function generatePhoneFormats(phone) {
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

/**
 * Format ISO date to local time string
 */
export function formatLocalText(iso, tz = 'America/Denver') {
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

/**
 * Calculate hours since a timestamp
 */
export function calculateHoursSince(timestamp) {
  if (!timestamp) return null;
  const past = new Date(timestamp);
  const now = new Date();
  return Math.round((now - past) / (1000 * 60 * 60) * 10) / 10;
}

/**
 * Safe JSON parse with fallback
 */
export async function safeJsonParse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text, _parseError: true };
  }
}

export { CORS_HEADERS };