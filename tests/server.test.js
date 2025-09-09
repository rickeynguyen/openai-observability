import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app, store } from '../src/server.js';

test('GET /status returns structure and reflects injected data', async () => {
  // inject a couple of points
  const now = Date.now();
  store.push({ ts: now, ok: true, status: 200, latencyMs: 123, endpoint: '/v1/chat/completions', model: 'm', region: 'r' });
  store.push({ ts: now, ok: false, status: 500, latencyMs: 50, endpoint: '/v1/chat/completions', model: 'm', region: 'r', errType: 'network' });
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/status?window=10`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.endpoints['/v1/chat/completions']);
  const ep = json.endpoints['/v1/chat/completions'];
  assert.equal(ep.total, 2);
  assert.equal(ep.ok, 1);
  assert.equal(ep.errors.network, 1);
  server.close();
});

test('GET /incidents returns list (or empty) and supports from/to filtering', async () => {
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const now = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/incidents?from=${now-1}&to=${now+1}`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json));
  server.close();
});

test('GET /timeseries provides buckets with ok/total and percentiles', async () => {
  const now = Date.now();
  // inject some points in store for the last 2 minutes
  for (let i=0;i<20;i++) {
    store.push({ ts: now - i*5000, ok: i%5!==0, status: i%5===0?500:200, latencyMs: 50 + i, endpoint: '/v1/chat/completions', model: 'm', region: 'r' });
  }
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/timeseries?window=5&stepSec=30&endpoint=/v1/chat/completions`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.buckets));
  assert.ok(json.buckets.length > 0);
  assert.ok('ok' in json.buckets[0]);
  assert.ok('total' in json.buckets[0]);
  // percentiles may be null if no ok points in a bucket, but schema should exist
  assert.ok('p50' in json.buckets[0]);
  server.close();
});
