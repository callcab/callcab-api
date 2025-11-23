// src/index.js (or wherever your Worker entry is)

// Existing handlers
import { handleValidateAddress } from './handlers/validate-address.js';
import { handleAccountEligibility } from './handlers/account-eligibility.js';
import { handleDispatchETA } from './handlers/dispatch-eta.js';
import { handleIcabbiLookup } from './handlers/icabbi-lookup.js';
import { handleIcabbiBooking } from './handlers/icabbi-booking.js';

// ✅ NEW: unified intelligence / greeting endpoint
import { handleCallcabLookupMaster } from './handlers/callcab-lookup-master.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === '/health' || path === '/') {
        return jsonResponse({
          ok: true,
          status: 'healthy',
          timestamp: new Date().toISOString(),
          version: '4.0.0',
          endpoints: [
            '/health',
            '/validate-address',
            '/account-eligibility',
            '/dispatch-eta',
            '/icabbi-lookup',
            '/icabbi-booking',
            '/callcab-lookup-master',
          ],
        });
      }

      // Route to handlers
      switch (path) {
        case '/validate-address':
          return await handleValidateAddress(request, env);

        case '/account-eligibility':
          return await handleAccountEligibility(request, env);

        case '/dispatch-eta':
          return await handleDispatchETA(request, env);

        case '/icabbi-lookup':
          return await handleIcabbiLookup(request, env);

        case '/icabbi-booking':
          return await handleIcabbiBooking(request, env);

        // ✅ NEW UNIFIED LOOKUP / GREETING ENDPOINT
        case '/callcab-lookup-master':
          return await handleCallcabLookupMaster(request, env);

        default:
          return jsonResponse(
            {
              ok: false,
              error: 'NOT_FOUND',
              message: `Endpoint ${path} not found`,
              available_endpoints: [
                '/health',
                '/validate-address',
                '/account-eligibility',
                '/dispatch-eta',
                '/icabbi-lookup',
                '/icabbi-booking',
                '/callcab-lookup-master',
              ],
            },
            404,
          );
      }
    } catch (error) {
      console.error('[index] Unhandled error:', error);
      return jsonResponse(
        {
          ok: false,
          error: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
        500,
      );
    }
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}