import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, store } from '../src/server.js';

test('POST /ingest/trace accepts valid trace and stores it', async () => {
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const trace = { ts: Date.now(), endpoint: '/v1/chat/completions', ok: true, status: 200, latencyMs: 42, model: 'gpt', region: 'us' };
  const res = await fetch(`http://127.0.0.1:${port}/ingest/trace`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(trace)
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  // ensure it landed in memory store
  const found = store.points.find(p => p.ts === trace.ts && p.endpoint === trace.endpoint);
  assert.ok(found);
  server.close();
});

test('POST /ingest/trace enforces API key when configured', async () => {
  process.env.INGEST_API_KEY = 'secret';
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const trace = { ts: Date.now(), endpoint: '/v1/responses', ok: false, status: 500, latencyMs: 100 };
  const res1 = await fetch(`http://127.0.0.1:${port}/ingest/trace`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(trace)
  });
  assert.equal(res1.status, 401);
  const res2 = await fetch(`http://127.0.0.1:${port}/ingest/trace`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'secret' }, body: JSON.stringify(trace)
  });
  assert.equal(res2.status, 200);
  server.close();
  delete process.env.INGEST_API_KEY;
});

test('POST /ingest/trace rejects invalid payload', async () => {
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const bad = { endpoint: 1, latencyMs: -3 }; // missing ts, types wrong
  const res = await fetch(`http://127.0.0.1:${port}/ingest/trace`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad)
  });
  assert.equal(res.status, 400);
  server.close();
});
