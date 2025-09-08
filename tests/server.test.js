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
