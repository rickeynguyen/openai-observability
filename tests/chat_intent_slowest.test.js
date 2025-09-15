import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, store } from '../src/server.js';

let server; let port;
async function startServer(){
  server = http.createServer(app); await new Promise(res=>server.listen(0,res)); port = server.address().port;
}
async function stopServer(){ if(server){ server.close(); await new Promise(r=>setTimeout(r,40)); } }

async function seed(){
  const now = Date.now();
  // Endpoint A (faster)
  for(let i=0;i<5;i++) store.push({ ts: now - i*1000, endpoint:'/v1/embeddings', ok:true, status:200, latencyMs: 100 + i*5, model:'m', region:'r' });
  // Endpoint B (slower)
  for(let i=0;i<5;i++) store.push({ ts: now - i*900 - 200, endpoint:'/v1/files', ok:true, status:200, latencyMs: 600 + i*30, model:'m', region:'r' });
}

test('chat slowest endpoint intent (non-stream)', async () => {
  await startServer(); await seed();
  try {
    const body = { messages:[{ role:'user', content:'Which is the slowest endpoint?' }], llm:false };
    const res = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    assert.equal(res.status,200);
    const j = await res.json();
    assert.match(j.answer, /Slowest endpoint/);
    assert.match(j.answer, /\/v1\/files/);
    // Should not include the generic baseline summary phrase
    assert.ok(!/In \d{4}-/.test(j.answer), 'direct answer avoids full baseline preface');
  } finally { await stopServer(); }
});

test('chat slowest endpoint intent (stream)', async () => {
  await startServer(); await seed();
  try {
    const body = { messages:[{ role:'user', content:'slowest endpoint please' }], llm:false };
    const data = Buffer.from(JSON.stringify(body));
    const streamRes = await new Promise((resolve,reject)=>{
      const req = http.request({ hostname:'127.0.0.1', port, path:'/ai/chat/stream', method:'POST', headers:{'Content-Type':'application/json','Content-Length':data.length}}, res=>{
        let buf=''; res.on('data',d=>buf+=d.toString()); res.on('end',()=>resolve({ status:res.statusCode, body:buf })); });
      req.on('error',reject); req.write(data); req.end();
    });
    assert.equal(streamRes.status,200);
    const lines = streamRes.body.trim().split(/\n+/).filter(Boolean);
    assert.ok(lines.length>1,'has streamed lines');
    const final = JSON.parse(lines[lines.length-1]);
    assert.equal(final.done,true);
    const deltas = lines.slice(0,-1).map(l=>{ try { const o=JSON.parse(l); return o.delta||'';} catch{ return ''; } }).join('');
    assert.match(deltas, /Slowest endpoint/);
    assert.match(deltas, /\/v1\/files/);
  } finally { await stopServer(); }
});
