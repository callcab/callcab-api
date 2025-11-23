// pages/api/restaurant-menu-item-pplx.js
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

export default async function handler(req, res) {
  const ALLOW_ORIGIN='*';
  if (req.method==='OPTIONS'){
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
    return res.status(200).end();
  }
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  if (req.method!=='POST') return res.status(405).json({ok:false,error:'METHOD_NOT_ALLOWED'});

  try {
    const apiKey = process.env.PERPLEXITY_API_KEY || req.headers.authorization?.replace(/^Bearer\s+/i,'');
    if(!apiKey) return res.status(401).json({ok:false,error:'NO_PPLX_KEY'});

    const { restaurant_name, location='Aspen Colorado', item_query, max_tokens=800 } = req.body || {};
    if(!restaurant_name || !item_query){
      return res.status(400).json({ok:false,error:'MISSING_PARAMS', need: ['restaurant_name','item_query']});
    }

    const schema = {
      type:'object',
      properties:{
        found:{type:'boolean'},
        name:{type:'string', nullable:true},
        section:{type:'string', nullable:true},
        priceText:{type:['string','null']},
        description:{type:['string','null']},
        alternates:{type:'array', items:{type:'string'}},
        menu_url:{type:['string','null']},
        source_urls:{type:'array', items:{type:'string'}}
      },
      required:['found']
    };

    const body = {
      model: 'sonar-pro',
      messages: [
        { role:'system', content:
          `You are a precise menu item locator.
Use search to confirm if the item exists on today's menu for the specified restaurant + location.
Return ONLY JSON per schema.`},
        { role:'user', content:
          `Restaurant: "${restaurant_name}" in ${location}
Item to find (exact or closest match): "${item_query}"
If not found, suggest up to 3 closest matches (by name).
Return menu_url, and top source URLs.`
        }
      ],
      temperature: 0.2,
      max_tokens,
      response_format: { type:'json_schema', json_schema:{ schema } }
    };

    const r = await fetch('https://api.perplexity.ai/chat/completions',{
      method:'POST',
      headers:{ 'Authorization':`Bearer ${apiKey}`, 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });

    const txt = await r.text();
    if(!r.ok){
      let detail; try{ detail=JSON.parse(txt);}catch{ detail=txt; }
      return res.status(502).json({ ok:false, error:'PPLX_API_ERROR', detail });
    }

    // Perplexity already structured-outputs; still guard for think text
    const content = JSON.parse(txt)?.choices?.[0]?.message?.content || '';
    const json = extractJson(content);
    if(!json) return res.status(502).json({ok:false,error:'NO_JSON'});

    let payload; try { payload = JSON.parse(json); } catch {
      return res.status(502).json({ok:false,error:'PARSE_FAIL'});
    }

    return res.status(200).json({ ok:true, ...payload });
  } catch (e){
    console.error('[restaurant-menu-item-pplx]', e);
    return res.status(500).json({ok:false,error:'ITEM_LOOKUP_FAILED',message:e?.message||'Unknown'});
  }
}

function extractJson(s){
  const start=s.indexOf('{'); if(start===-1) return null;
  let depth=0;
  for(let i=start;i<s.length;i++){
    const ch=s[i];
    if(ch==='{') depth++;
    if(ch==='}'){ depth--; if(depth===0) return s.slice(start, i+1); }
  }
  return null;
}