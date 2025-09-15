import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../src/server.js';

test('chart intent (non-stream pie errors)', async () => {
  const server = http.createServer(app); await new Promise(r=>server.listen(0,r)); const port = server.address().port;
  const body = { messages:[{ role:'user', content:'Show me a pie chart of errors' }], llm:false };
  const res = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  assert.equal(res.status,200);
  const j = await res.json();
  assert.ok(j.chartSpec, 'expected chartSpec');
  assert.equal(j.chartSpec.type, 'pie');
  server.close();
});

test('chart intent (non-stream latency bar)', async () => {
  const server = http.createServer(app); await new Promise(r=>server.listen(0,r)); const port = server.address().port;
  const body = { messages:[{ role:'user', content:'Give me a bar chart of endpoint latency p95' }], llm:false };
  const res = await fetch(`http://127.0.0.1:${port}/ai/chat`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  assert.equal(res.status,200);
  const j = await res.json();
  assert.ok(j.chartSpec, 'expected chartSpec');
  assert.equal(j.chartSpec.type, 'bar');
  server.close();
});

test('chart intent (stream pie errors)', async () => {
  const server = http.createServer(app); await new Promise(r=>server.listen(0,r)); const port = server.address().port;
  const body = { messages:[{ role:'user', content:'Visualize errors as a pie chart' }], llm:false };
  const res = await fetch(`http://127.0.0.1:${port}/ai/chat/stream`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  assert.equal(res.status,200);
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  let leftover=''; let finalObj=null;
  while(true){ const {value, done} = await reader.read(); if(done) break; leftover += decoder.decode(value,{stream:true}); let idx; while((idx=leftover.indexOf('\n'))>=0){ const line=leftover.slice(0,idx); leftover=leftover.slice(idx+1); if(!line.trim()) continue; try{ const o=JSON.parse(line); if(o.done) finalObj=o; }catch(_){} } }
  assert.ok(finalObj && finalObj.chartSpec, 'expected chartSpec in stream final');
  assert.equal(finalObj.chartSpec.type, 'pie');
  server.close();
});

test('chart intent (stream bar latency)', async () => {
  const server = http.createServer(app); await new Promise(r=>server.listen(0,r)); const port = server.address().port;
  const body = { messages:[{ role:'user', content:'Plot a bar chart of latency per endpoint' }], llm:false };
  const res = await fetch(`http://127.0.0.1:${port}/ai/chat/stream`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  assert.equal(res.status,200);
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  let leftover=''; let finalObj=null;
  while(true){ const {value, done} = await reader.read(); if(done) break; leftover += decoder.decode(value,{stream:true}); let idx; while((idx=leftover.indexOf('\n'))>=0){ const line=leftover.slice(0,idx); leftover=leftover.slice(idx+1); if(!line.trim()) continue; try{ const o=JSON.parse(line); if(o.done) finalObj=o; }catch(_){} } }
  assert.ok(finalObj && finalObj.chartSpec, 'expected chartSpec in stream final');
  assert.equal(finalObj.chartSpec.type, 'bar');
  server.close();
});
