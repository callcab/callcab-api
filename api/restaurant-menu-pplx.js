// pages/api/restaurant-menu-pplx.js
// Perplexity full-menu fetch with JSON-Schema structured output, retries, and safe JSON extraction

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
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
    const apiKey = process.env.PERPLEXITY_API_KEY || req.headers.authorization?.replace(/^Bearer\s+/i,'');
    if (!apiKey) {
      return res.status(401).json({ ok: false, error: 'NO_PPLX_KEY' });
    }

    const {
      restaurant_name,
      location = 'Aspen Colorado',
      max_items = 120,
      // optional hints:
      website_hint,
      force_refresh = false
    } = req.body || {};

    if (!restaurant_name) {
      return res.status(400).json({ ok: false, error: 'MISSING_RESTAURANT_NAME' });
    }

    // Build prompt
    const userPrompt = `
Return today's full food & drink menu for "${restaurant_name}" in ${location}.
Use official sources (restaurant site / hosted menus) and recent reviews only to verify availability/prices.
If multiple menus exist (brunch/lunch/dinner/happy hour), include all.
Normalize into sections with items: name, priceText, description; keep priceText as shown (e.g. "MP", "$18", "$10–$15").
Also return: menu_url (best canonical), source_urls (top citations), and 6–10 "popular" picks.
If something is market price or rotates daily, keep "market price" or similar text.
Output strictly as JSON matching the schema. Do not include commentary.
`;

    const models = [
      'sonar-pro', // primary
      'sonar'      // fallback
    ];

    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        location: { type: 'string' },
        menu_url: { type: 'string', nullable: true },
        source_urls: { type: 'array', items: { type: 'string' } },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    priceText: { type: ['string', 'null'] },
                    description: { type: ['string', 'null'] }
                  },
                  required: ['name']
                }
              }
            },
            required: ['label', 'items']
          }
        },
        popular: { type: 'array', items: { type: 'string' } }
      },
      required: ['name', 'location', 'sections']
    };

    // helper: call pplx once
    const callPplx = async (model) => {
      const body = {
        model,
        messages: [
          { role: 'system',
            content: `You are a precise menu extraction agent. Always verify via search.
Return ONLY JSON that conforms to the provided JSON schema.`
          },
          ...(website_hint ? [{
            role: 'system',
            content: `Website hint: ${website_hint}`
          }] : []),
          { role: 'user', content: userPrompt }
        ],
        // enable search; Perplexity does this automatically for sonar models
        // keep max_tokens generous for long menus:
        max_tokens: 4000,
        temperature: 0.2,
        response_format: {
          type: 'json_schema',
          json_schema: { schema }
        }
      };

      const r = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });

      const text = await r.text();
      if (!r.ok) {
        let detail;
        try { detail = JSON.parse(text); } catch { detail = text; }
        return { ok: false, status: r.status, detail };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { ok: false, status: 502, detail: 'Bad JSON from Perplexity' };
      }

      const content = data?.choices?.[0]?.message?.content;
      if (!content || typeof content !== 'string') {
        return { ok: false, status: 502, detail: 'Missing content' };
      }

      // If a reasoning model ever adds <think>, extract JSON chunk:
      const jsonStr = extractJson(content);
      if (!jsonStr) return { ok: false, status: 502, detail: 'No JSON payload' };

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        return { ok: false, status: 502, detail: 'Menu JSON parse error' };
      }

      // trim lengths
      if (Array.isArray(parsed.sections)) {
        parsed.sections.forEach(s => {
          if (Array.isArray(s.items) && s.items.length > max_items) {
            s.items = s.items.slice(0, max_items);
          }
        });
      }
      if (Array.isArray(parsed.popular) && parsed.popular.length > 20) {
        parsed.popular = parsed.popular.slice(0, 20);
      }

      return { ok: true, payload: parsed };
    };

    // model + retry strategy
    let lastErr = null;
    for (const m of models) {
      const out = await withTimeout(() => callPplx(m), 28000); // keep fast to avoid Vercel timeouts
      if (out?.ok) {
        return res.status(200).json({
          ok: true,
          name: out.payload.name || restaurant_name,
          location,
          menu_url: out.payload.menu_url || null,
          source_urls: out.payload.source_urls || [],
          sections: out.payload.sections || [],
          popular: out.payload.popular || []
        });
      }
      lastErr = out;
      // small backoff
      await sleep(400);
    }

    return res.status(502).json({
      ok: false,
      error: 'PPLX_API_ERROR',
      details: lastErr?.detail || 'Unknown Perplexity error'
    });

  } catch (e) {
    console.error('[restaurant-menu-pplx] fatal', e);
    return res.status(500).json({ ok: false, error: 'MENU_FETCH_FAILED', message: e?.message || 'Unknown error' });
  }
}

// ---- helpers ----

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function withTimeout(fn, ms){
  let timer;
  try {
    return await Promise.race([
      fn(),
      new Promise((_,rej)=>{ timer=setTimeout(()=>rej(new Error('TIMEOUT')), ms); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function extractJson(s){
  // grab first {...} JSON object in the string
  const start = s.indexOf('{');
  if (start === -1) return null;
  // naive bracket match
  let depth = 0;
  for (let i=start; i<s.length; i++){
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i+1);
    }
  }
  return null;
}