#!/usr/bin/env node
/**
 * VAPI Setup CLI - High Mountain Taxi
 * 
 * Creates workflow-based assistant with visual nodes
 * 
 * Usage:
 *   node setup-vapi.js create          # Create workflow assistant
 *   node setup-vapi.js create-simple   # Create simple conversational assistant
 *   node setup-vapi.js update <id>
 *   node setup-vapi.js export <id>     # Export workflow as JSON
 */

require('dotenv').config();
const fs = require('fs');
const readline = require('readline');

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  VAPI_API_KEY: '8ebf2400-7a3c-4f6c-8aab-7ab4fe3372e5',
  VAPI_PUBLIC_KEY: '43ae4352-c50d-428c-a4d6-d6c2c5da3d33',
  BACKEND_URL: 'https://aspen-address-validator.vercel.app/api/setup-vapi' || 'https://your-backend.vercel.app',
  SERVER_SECRET: 'zpCjLOOk3vW0gyJpNgYqZccLwdVETm5Z' || 'your_server_secret',
  DISPATCH_PHONE: process.env.DISPATCH_PHONE || '+13109635871',
  VAPI_BASE: 'https://api.vapi.ai'
};

if (!CONFIG.VAPI_API_KEY) {
  console.error('❌ Error: VAPI_API_KEY not found');
  console.log('\nCreate .env with: VAPI_API_KEY=sk_live_...');
  process.exit(1);
}

// ============================================================================
// WORKFLOW NODES DEFINITION
// ============================================================================

const NODES = {
  start: {
    type: 'start',
    name: 'Introduction',
    messages: [
      {
        role: 'assistant',
        content: 'Thank you for calling High Mountain Taxi. This is Claire. How can I help?'
      },
      {
        role: 'system',
        content: 'You are Claire from High Mountain Taxi. Listen to what the customer needs - taxi or food. Extract their intent. Keep it BRIEF - max 2 sentences. ALWAYS convert numbers to words.'
      }
    ],
    conditions: [
      {
        type: 'model-output',
        output: {
          type: 'enum',
          enum: ['taxi', 'food', 'both', 'unclear']
        },
        name: 'service_type'
      }
    ],
    edges: [
      {
        condition: "{{service_type}} == 'taxi'",
        destination: 'collect_contact'
      },
      {
        condition: "{{service_type}} == 'food'",
        destination: 'food_intro'
      },
      {
        condition: "{{service_type}} == 'unclear'",
        destination: 'clarify_service'
      }
    ]
  },

  clarify_service: {
    type: 'conversation',
    name: 'Clarify Service',
    messages: [
      {
        role: 'system',
        content: 'Ask: "Are you looking for a ride or food delivery?" Keep brief.'
      }
    ],
    conditions: [
      {
        type: 'model-output',
        output: { type: 'enum', enum: ['taxi', 'food', 'both'] },
        name: 'service_type'
      }
    ],
    edges: [
      { condition: "{{service_type}} == 'taxi'", destination: 'collect_contact' },
      { condition: "{{service_type}} == 'food'", destination: 'food_intro' }
    ]
  },

  collect_contact: {
    type: 'conversation',
    name: 'Get Name & Phone',
    messages: [
      {
        role: 'system',
        content: `Check {{customer.number}}. If exists, confirm (convert to words: "I see your number as nine seven zero..."). If not, ask: "Name and a good callback number?" Validate 10 digits. Convert phone to words when confirming. Max 2 sentences.`
      }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'string' }, name: 'customer_name' },
      { type: 'model-output', output: { type: 'string', pattern: '^\\d{10}$' }, name: 'customer_phone' }
    ],
    edges: [
      { condition: '{{customer_name}} && {{customer_phone}}', destination: 'get_pickup' }
    ]
  },

  get_pickup: {
    type: 'conversation',
    name: 'Get Pickup Location',
    messages: [
      {
        role: 'system',
        content: `Ask: "Where should we pick you up?" Translate casual names (Jerome → Hotel Jerome Aspen Colorado). Before calling validate_address, say "Just checking..." While waiting, mention: "By the way, we deliver 24/7." Extract location.`
      }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'validate_address',
          arguments: {
            query: '{{pickup_raw}} Colorado',
            isPickup: true
          }
        },
        messages: [
          { role: 'assistant', content: 'Just checking...' },
          { role: 'assistant', content: 'Still looking... we deliver steaks 24/7.', delayMs: 3000 },
          { role: 'assistant', content: 'One sec...', delayMs: 6000 }
        ]
      },
      {
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: {
            lat: '{{pickup_lat}}',
            lng: '{{pickup_lng}}'
          }
        },
        silent: true
      }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'string' }, name: 'pickup_raw' },
      { type: 'tool-call', output: { type: 'boolean' }, name: 'pickup_validated', source: 'validate_address.is_valid' },
      { type: 'tool-call', output: { type: 'number' }, name: 'pickup_lat', source: 'validate_address.lat' },
      { type: 'tool-call', output: { type: 'number' }, name: 'pickup_lng', source: 'validate_address.lng' },
      { type: 'tool-call', output: { type: 'string' }, name: 'daypart', source: 'get_weather.daypart' },
      { type: 'tool-call', output: { type: 'number' }, name: 'temperature', source: 'get_weather.temperature' }
    ],
    edges: [
      { condition: '{{pickup_validated}} == true', destination: 'get_timing' },
      { condition: '{{pickup_validated}} == false', destination: 'pickup_retry' }
    ]
  },

  pickup_retry: {
    type: 'conversation',
    name: 'Retry Pickup',
    messages: [
      { role: 'system', content: 'Say: "Can\'t find that exact spot. Cross street or landmark nearby?" Try again.' }
    ],
    maxRetries: 2,
    edges: [
      { condition: '{{pickup_validated}} == true', destination: 'get_timing' },
      { condition: '{{retry_count}} >= 2', destination: 'transfer_dispatch' }
    ]
  },

  get_timing: {
    type: 'conversation',
    name: 'Get Timing',
    messages: [
      {
        role: 'system',
        content: `Confirm pickup with weather. CRITICAL: Check {{daypart}}. If "day" AND condition "sunny": say "Beautiful [temp] degrees". If "night" OR "evening": NEVER say "sunny" - say "Clear night, [temp] degrees". Then ask: "When do you need it — now or later?"`
      }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'enum', enum: ['asap', 'scheduled'] }, name: 'ride_timing' },
      { type: 'model-output', output: { type: 'string' }, name: 'scheduled_time', required: false }
    ],
    edges: [
      { condition: "{{ride_timing}} == 'asap'", destination: 'get_eta' },
      { condition: "{{ride_timing}} == 'scheduled'", destination: 'get_dropoff' }
    ]
  },

  get_eta: {
    type: 'conversation',
    name: 'Get Driver ETA',
    messages: [
      { role: 'system', content: 'Say "Checking drivers..." then call dispatch_eta. Convert to words: "Looks like about twelve minutes."' }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'dispatch_eta',
          arguments: {
            pickup_lat: '{{pickup_lat}}',
            pickup_lng: '{{pickup_lng}}'
          }
        },
        messages: [
          { role: 'assistant', content: 'Checking drivers...' },
          { role: 'assistant', content: 'Checking who\'s closest...', delayMs: 3000 }
        ]
      }
    ],
    conditions: [
      { type: 'tool-call', output: { type: 'number' }, name: 'eta_minutes', source: 'dispatch_eta.total_eta_minutes' }
    ],
    edges: [
      { condition: '{{eta_minutes}} > 0', destination: 'get_dropoff' }
    ]
  },

  get_dropoff: {
    type: 'conversation',
    name: 'Get Dropoff',
    messages: [
      { role: 'system', content: 'Ask: "Where are you headed?" Extract location. Say "Just checking..." then validate.' }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'validate_address',
          arguments: {
            query: '{{dropoff_raw}} Colorado',
            isPickup: false
          }
        }
      }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'string' }, name: 'dropoff_raw' },
      { type: 'tool-call', output: { type: 'boolean' }, name: 'dropoff_validated', source: 'validate_address.is_valid' },
      { type: 'tool-call', output: { type: 'number' }, name: 'dropoff_lat', source: 'validate_address.lat' },
      { type: 'tool-call', output: { type: 'number' }, name: 'dropoff_lng', source: 'validate_address.lng' }
    ],
    edges: [
      { condition: '{{dropoff_validated}} == true', destination: 'get_route_quote' }
    ]
  },

  get_route_quote: {
    type: 'conversation',
    name: 'Route Quote',
    messages: [
      { role: 'system', content: 'Say "Getting your quote..." Call route_quote. Add LOCAL FLAIR: "Quick shot up Eighty-Two to the airport." Convert numbers to words.' }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'route_quote',
          arguments: {
            pickup: {
              lat: '{{pickup_lat}}',
              lng: '{{pickup_lng}}'
            },
            dropoff: {
              lat: '{{dropoff_lat}}',
              lng: '{{dropoff_lng}}'
            }
          }
        },
        messages: [
          { role: 'assistant', content: 'Getting your quote...' }
        ]
      }
    ],
    conditions: [
      { type: 'tool-call', output: { type: 'number' }, name: 'fare_low', source: 'route_quote.fare_estimate_low' },
      { type: 'tool-call', output: { type: 'number' }, name: 'fare_high', source: 'route_quote.fare_estimate_high' }
    ],
    edges: [
      { condition: '{{fare_low}} > 0', destination: 'get_passengers' }
    ]
  },

  get_passengers: {
    type: 'conversation',
    name: 'Passengers & Items',
    messages: [
      { role: 'system', content: 'Ask: "How many passengers?" Then: "Any luggage, skis, pets?" Handle Tipsy Taxi.' }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'number' }, name: 'passengers' },
      { type: 'model-output', output: { type: 'array' }, name: 'special_items' }
    ],
    edges: [
      { condition: '{{passengers}} > 6', destination: 'transfer_dispatch' },
      { condition: true, destination: 'confirm_booking' }
    ]
  },

  confirm_booking: {
    type: 'conversation',
    name: 'Confirm Booking',
    messages: [
      { role: 'system', content: 'Confirm: "[pickup] to [dropoff], [time], [passengers] passengers. Sound good?"' }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'boolean' }, name: 'confirmed' }
    ],
    edges: [
      { condition: '{{confirmed}} == true', destination: 'food_upsell' },
      { condition: '{{confirmed}} == false', destination: 'get_pickup' }
    ]
  },

  food_upsell: {
    type: 'conversation',
    name: 'REQUIRED Food Upsell',
    messages: [
      {
        role: 'system',
        content: `CRITICAL: Food upsell REQUIRED. Choose context:
- Evening: "All set! We deliver food too - steaks, seafood, Matt's calzone."
- Late night: "We deliver late night too - Matt's calzone won Best Late Night."
- General: "We deliver 24/7 — hungry at 3 AM? We got you."
Extract if interested.`
      }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'boolean' }, name: 'wants_food' }
    ],
    edges: [
      { condition: '{{wants_food}} == true', destination: 'food_intro' },
      { condition: '{{wants_food}} == false', destination: 'final_summary_taxi' }
    ]
  },

  final_summary_taxi: {
    type: 'conversation',
    name: 'Taxi Summary',
    messages: [
      { role: 'system', content: 'Give summary (convert ALL numbers to words). Mention weather with daypart check. Add: "We deliver food too. Thanks for calling!" Then send SMS.' }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'send_sms',
          arguments: {
            to: CONFIG.DISPATCH_PHONE,
            message: 'TAXI: {{customer_name}}, {{customer_phone}}, {{pickup_address}} → {{dropoff_address}}, {{ride_timing}}'
          }
        },
        silent: true
      }
    ],
    edges: [
      { condition: true, destination: 'end_call' }
    ]
  },

  food_intro: {
    type: 'conversation',
    name: 'Food Intro',
    messages: [
      { role: 'system', content: 'Say: "We\'ve got steaks, seafood, pasta, desserts. What sounds good?" Extract category.' }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'enum', enum: ['steaks', 'seafood', 'pasta', 'calzone', 'cheap'] }, name: 'food_category' }
    ],
    edges: [
      { condition: "{{food_category}} == 'calzone' || {{food_category}} == 'cheap'", destination: 'matts_calzone' },
      { condition: true, destination: 'build_order' }
    ]
  },

  matts_calzone: {
    type: 'conversation',
    name: 'Matt\'s Calzone Pitch',
    messages: [
      { role: 'system', content: 'Say: "Matt\'s Calzone - seven ninety-nine. Won Best Late Night Delivery in college. Started his whole journey. Want one?" No minimum for calzones.' }
    ],
    edges: [
      { condition: true, destination: 'build_order' }
    ]
  },

  build_order: {
    type: 'conversation',
    name: 'Build Order',
    messages: [
      { role: 'system', content: 'Take orders. For each: "Perfect - [item], [price as words]. [Detail]. Anything else?" Track subtotal. Check $75 min (except calzones). When done: "Where should we deliver?"' }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'array' }, name: 'food_items' },
      { type: 'model-output', output: { type: 'number' }, name: 'food_subtotal' },
      { type: 'model-output', output: { type: 'boolean' }, name: 'order_complete' }
    ],
    maxDuration: 120,
    edges: [
      { condition: '{{order_complete}} == true', destination: 'get_delivery_address' }
    ]
  },

  get_delivery_address: {
    type: 'conversation',
    name: 'Delivery Address',
    messages: [
      { role: 'system', content: 'Ask: "Where should we deliver?" Validate address.' }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'validate_address',
          arguments: { query: '{{delivery_raw}} Colorado', isPickup: false }
        }
      },
      {
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: { lat: '{{delivery_lat}}', lng: '{{delivery_lng}}' }
        },
        silent: true
      }
    ],
    edges: [
      { condition: '{{delivery_validated}} == true', destination: 'food_quote_calc' }
    ]
  },

  food_quote_calc: {
    type: 'conversation',
    name: 'Food Quote',
    messages: [
      { role: 'system', content: 'Say "Getting delivery time..." Call route_quote from kitchen. Add 30 min cook time. Announce total.' }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'route_quote',
          arguments: {
            pickup: { lat: 39.2228, lng: -106.8692 },
            dropoff: { lat: '{{delivery_lat}}', lng: '{{delivery_lng}}' }
          }
        }
      }
    ],
    edges: [
      { condition: true, destination: 'food_payment' }
    ]
  },

  food_payment: {
    type: 'conversation',
    name: 'Food Payment',
    messages: [
      { role: 'system', content: 'Say: "I\'ll text you a payment link. Total [subtotal] for food. Taxi delivery metered. Please tip your driver."' }
    ],
    edges: [
      { condition: true, destination: 'confirm_food' }
    ]
  },

  confirm_food: {
    type: 'conversation',
    name: 'Confirm Food',
    messages: [
      { role: 'system', content: 'Confirm: "[items] to [location] in [time]. [Subtotal] plus taxi fare. Sound good?"' }
    ],
    conditions: [
      { type: 'model-output', output: { type: 'boolean' }, name: 'food_confirmed' }
    ],
    edges: [
      { condition: '{{food_confirmed}} == true', destination: 'final_summary_food' },
      { condition: '{{food_confirmed}} == false', destination: 'build_order' }
    ]
  },

  final_summary_food: {
    type: 'conversation',
    name: 'Food Summary',
    messages: [
      { role: 'system', content: 'Summary with weather. Check texts for payment. Driver will call. Thanks!' }
    ],
    toolCalls: [
      {
        type: 'function',
        function: {
          name: 'send_sms',
          arguments: {
            message: 'FOOD: {{customer_name}}, {{food_items}}, {{delivery_address}}'
          }
        },
        silent: true
      }
    ],
    edges: [
      { condition: true, destination: 'end_call' }
    ]
  },

  transfer_dispatch: {
    type: 'transfer',
    name: 'Transfer to Dispatch',
    destination: CONFIG.DISPATCH_PHONE,
    messages: [
      { role: 'assistant', content: 'Let me connect you with dispatch.' }
    ]
  },

  end_call: {
    type: 'end',
    name: 'End Call',
    endCallMessage: 'Thanks for calling High Mountain Taxi!'
  }
};

// ============================================================================
// TOOLS CONFIGURATION
// ============================================================================

const TOOLS = [
  {
    type: 'function',
    async: true,
    function: {
      name: 'validate_address',
      description: 'Validates address, returns coordinates.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          isPickup: { type: 'boolean' }
        },
        required: ['query', 'isPickup']
      }
    },
    server: {
      url: `${CONFIG.BACKEND_URL}/api/google-validate-address`,
      secret: CONFIG.SERVER_SECRET
    }
  },
  {
    type: 'function',
    async: true,
    function: {
      name: 'get_weather',
      description: 'Gets weather. SILENT.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number' },
          lng: { type: 'number' }
        }
      }
    },
    server: {
      url: `${CONFIG.BACKEND_URL}/api/weather`,
      secret: CONFIG.SERVER_SECRET
    }
  },
  {
    type: 'function',
    async: true,
    function: {
      name: 'dispatch_eta',
      description: 'Gets driver ETA.',
      parameters: {
        type: 'object',
        properties: {
          pickup_lat: { type: 'number' },
          pickup_lng: { type: 'number' }
        }
      }
    },
    server: {
      url: `${CONFIG.BACKEND_URL}/api/dispatch`,
      secret: CONFIG.SERVER_SECRET
    }
  },
  {
    type: 'function',
    async: true,
    function: {
      name: 'route_quote',
      description: 'Route and fare quote.',
      parameters: {
        type: 'object',
        properties: {
          pickup: { type: 'object' },
          dropoff: { type: 'object' }
        }
      }
    },
    server: {
      url: `${CONFIG.BACKEND_URL}/api/route-quote`,
      secret: CONFIG.SERVER_SECRET
    }
  },
  {
    type: 'function',
    async: true,
    function: {
      name: 'send_sms',
      description: 'Send SMS to dispatch.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', default: CONFIG.DISPATCH_PHONE },
          message: { type: 'string' }
        }
      }
    },
    server: {
      url: `${CONFIG.BACKEND_URL}/api/send-sms`,
      secret: CONFIG.SERVER_SECRET
    }
  }
];

// ============================================================================
// API FUNCTIONS
// ============================================================================

async function apiCall(method, endpoint, data = null) {
  const url = `${CONFIG.VAPI_BASE}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${CONFIG.VAPI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  };

  if (data) options.body = JSON.stringify(data);

  const response = await fetch(url, options);
  const text = await response.text();
  const result = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`API Error (${response.status}): ${JSON.stringify(result)}`);
  }

  return result;
}

// ============================================================================
// CREATE WORKFLOW ASSISTANT
// ============================================================================

async function createWorkflowAssistant() {
  console.log('🚀 Creating WORKFLOW assistant with visual nodes...\n');

  try {
    const config = {
      name: 'Claire - High Mountain Taxi (Workflow)',
      
      // Workflow type (not conversational)
      type: 'workflow',
      
      // First node
      firstNode: 'start',
      
      // All workflow nodes
      nodes: NODES,
      
      // Global voice settings
      voice: {
        provider: '11labs',
        voiceId: '21m00Tcm4TlvDq8ikWAM',
        stability: 0.7,
        similarityBoost: 0.8
      },
      
      // Global model settings
      model: {
        provider: 'openai',
        model: 'gpt-4-turbo',
        temperature: 0.7,
        maxTokens: 250,
        tools: TOOLS
      },
      
      // Transcriber
      transcriber: {
        provider: 'deepgram',
        model: 'nova-2'
      },
      
      // Behavior
      responseDelaySeconds: 0.4,
      interruptionsEnabled: true,
      numWordsToInterruptAssistant: 2,
      
      // Server config
      serverUrl: `${CONFIG.BACKEND_URL}/api/vapi-webhook`,
      serverUrlSecret: CONFIG.SERVER_SECRET
    };

    console.log('📝 Creating workflow with 23 nodes...');
    const assistant = await apiCall('POST', '/assistant', config);
    
    console.log(`✅ Workflow assistant created: ${assistant.id}`);
    console.log(`   Nodes: ${Object.keys(NODES).length}`);
    console.log(`   Tools: ${TOOLS.length}`);
    
    console.log('\n' + '='.repeat(60));
    console.log('✨ SUCCESS! Workflow assistant ready!');
    console.log('='.repeat(60));
    console.log(`\n📊 Dashboard: https://dashboard.vapi.ai/assistants/${assistant.id}`);
    console.log('\n🎯 Next: Open dashboard to see visual workflow!');
    
    return assistant;
    
  } catch (error) {
    console.error('\n❌ Workflow creation failed:', error.message);
    throw error;
  }
}

// ============================================================================
// EXPORT WORKFLOW
// ============================================================================

async function exportWorkflow(assistantId) {
  console.log(`📤 Exporting workflow ${assistantId}...\n`);
  
  try {
    const assistant = await apiCall('GET', `/assistant/${assistantId}`);
    
    const filename = `workflow-${assistantId}-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(assistant, null, 2));
    
    console.log(`✅ Exported to: ${filename}`);
    console.log(`   Nodes: ${assistant.nodes ? Object.keys(assistant.nodes).length : 0}`);
    
    return filename;
    
  } catch (error) {
    console.error('❌ Export failed:', error.message);
    throw error;
  }
}

// ============================================================================
// IMPORT WORKFLOW
// ============================================================================

async function importWorkflow(filename) {
  console.log(`📥 Importing workflow from ${filename}...\n`);
  
  try {
    const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
    
    // Remove ID fields for new creation
    delete data.id;
    delete data.createdAt;
    delete data.updatedAt;
    
    data.name = `${data.name} (Imported)`;
    
    const assistant = await apiCall('POST', '/assistant', data);
    
    console.log(`✅ Imported as: ${assistant.id}`);
    
    return assistant;
    
  } catch (error) {
    console.error('❌ Import failed:', error.message);
    throw error;
  }
}

// ============================================================================
// CLI COMMANDS
// ============================================================================

async function listAssistants() {
  const assistants = await apiCall('GET', '/assistant');
  
  console.log(`📋 Found ${assistants.length} assistant(s):\n`);
  assistants.forEach((a, i) => {
    console.log(`${i + 1}. ${a.name}`);
    console.log(`   ID: ${a.id}`);
    console.log(`   Type: ${a.type || 'conversational'}`);
    console.log(`   Nodes: ${a.nodes ? Object.keys(a.nodes).length : 'N/A'}`);
    console.log('');
  });
}

async function createPhoneNumber(assistantId) {
  const phone = await apiCall('POST', '/phone-number', {
    provider: 'vapi',
    assistantId: assistantId,
    name: 'High Mountain Taxi'
  });
  
  console.log(`✅ Phone: ${phone.number || phone.sipUri}`);
  return phone;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const param = args[1];

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║       High Mountain Taxi - VAPI Workflow CLI v2.0        ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    switch (command) {
      case 'create':
        await createWorkflowAssistant();
        break;
        
      case 'list':
        await listAssistants();
        break;
        
      case 'phone':
        if (!param) {
          console.error('❌ Usage: node setup-vapi.js phone <assistant-id>');
          process.exit(1);
        }
        await createPhoneNumber(param);
        break;
        
      case 'export':
        if (!param) {
          console.error('❌ Usage: node setup-vapi.js export <assistant-id>');
          process.exit(1);
        }
        await exportWorkflow(param);
        break;
        
      case 'import':
        if (!param) {
          console.error('❌ Usage: node setup-vapi.js import <filename.json>');
          process.exit(1);
        }
        await importWorkflow(param);
        break;
        
      default:
        console.log('Commands:');
        console.log('  create              Create workflow assistant (23 nodes)');
        console.log('  list                List all assistants');
        console.log('  phone <id>          Create phone number');
        console.log('  export <id>         Export workflow to JSON');
        console.log('  import <file>       Import workflow from JSON');
        console.log('\nExamples:');
        console.log('  node setup-vapi.js create');
        console.log('  node setup-vapi.js export abc123');
        console.log('  node setup-vapi.js import workflow-abc123.json');
        break;
    }
  } catch (error) {
    console.error('\n💥 Error:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  createWorkflowAssistant,
  exportWorkflow,
  importWorkflow,
  NODES,
  TOOLS
};