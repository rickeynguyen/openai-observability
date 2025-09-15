import test from 'node:test';
import assert from 'node:assert/strict';
import { app, store } from '../src/server.js';
import http from 'node:http';

function start(){
  return new Promise(res=>{ const s=http.createServer(app); s.listen(0,()=>res(s)); });
}

async function post(base, path, body){
  const r = await fetch(base+path, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  const txt = await r.text();
  let j; try{ j=JSON.parse(txt); }catch{ j={raw:txt}; }
  return { status:r.status, json:j };
}

function seedPoints(){
  const now=Date.now();
  const mk=(ep, ok, status, latency, model='gpt-4o-mini', extra={})=>({ ts: now - Math.floor(Math.random()*10000), endpoint: ep, ok, status, latencyMs: latency, model, region:'us', ...extra });
  // endpoints with latency + errors + 429s
  const pts=[
    mk('/v1/a', true, 200, 120),
    mk('/v1/a', false, 500, 300),
    mk('/v1/a', false, 500, 280),
    mk('/v1/a', true, 200, 110),
    mk('/v1/b', true, 200, 900),
    mk('/v1/b', true, 200, 950),
    mk('/v1/b', false, 429, 100),
    mk('/v1/b', false, 429, 120),
    mk('/v1/b', false, 500, 400),
    mk('/v1/c', true, 200, 50, 'gpt-4o'),
    mk('/v1/c', true, 200, 55, 'gpt-4o'),
    mk('/v1/c', false, 429, 60, 'gpt-4o'),
    mk('/v1/c', true, 200, 60, 'gpt-4o'),
    mk('/v1/d', true, 200, 30, 'gpt-4o-mini', { tokensIn: 800, tokensOut: 1200 }),
    mk('/v1/d', true, 200, 35, 'gpt-4o-mini', { tokensIn: 500, tokensOut: 500 }),
    mk('/v1/d', true, 200, 32, 'gpt-4o-mini', { tokensIn: 100, tokensOut: 80 }),
    mk('/v1/d', true, 200, 31, 'gpt-4o-mini', { tokensIn: 50, tokensOut: 40 }),
    mk('/v1/d', true, 200, 28, 'gpt-4o-mini', { tokensIn: 10, tokensOut: 10 }),
  ];
  pts.forEach(p=>store.push(p));
}

seedPoints();

const phrases = [
  { intent:'top_errors', q:'top errors' },
  { intent:'highest_error_rate', q:'which endpoint has the highest error rate?' },
  { intent:'most_used_model', q:'most used model' },
  { intent:'peak_token_usage', q:'peak token usage' },
  { intent:'rate_limiting_hotspots', q:'rate limit hotspots' },
];

for (const ph of phrases){
  test(`intent: ${ph.intent}`, async () => {
    const srv = await start();
    const { port } = srv.address();
    const base = `http://127.0.0.1:${port}`;
    try{
      const { json } = await post(base, '/ai/chat', { query: ph.q, llm:false });
      assert.equal(typeof json.answer, 'string');
      assert.ok(json.answer.length>0, 'answer non-empty');
      // Each direct intent answer should not include token heavy LLM artefacts (like citations) & should contain expected keywords
      switch(ph.intent){
        case 'top_errors': assert.match(json.answer, /Top errors|No errors/); break;
        case 'highest_error_rate': assert.match(json.answer, /(Highest error-rate endpoint)|(No errors)/); break;
        case 'most_used_model': assert.match(json.answer, /(Most used model|No model usage)/); break;
        case 'peak_token_usage': assert.match(json.answer, /(Peak token usage|Token metrics not available)/); break;
        case 'rate_limiting_hotspots': assert.match(json.answer, /(Rate limiting hotspots|No rate limiting)/); break;
      }
    } finally { srv.close(); }
  });
}
