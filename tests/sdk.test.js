import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import app, { store } from '../src/server.js';
import { createIngestClient, wrapCall } from '../packages/sdk-js/index.js';

// Helper to start/stop the express app on a random port
function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, url: `http://${addr.address}:${addr.port}` });
    });
  });
}

test('sdk: recordTrace posts to ingest and updates memory store', async (t) => {
  const { server, url } = await startServer();
  await t.test('post trace', async () => {
    const before = store.points.length;
    const client = createIngestClient({ baseUrl: url });
    await client.recordTrace({ ts: Date.now(), endpoint: 'test', ok: true, latencyMs: 12 });
    const after = store.points.length;
    assert.equal(after, before + 1);
  });
  server.close();
});

test('sdk: wrapCall measures latency and extracts usage', async (t) => {
  const { server, url } = await startServer();
  await t.test('wrapCall success', async () => {
    const fn = async () => ({ usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } });
    const client = createIngestClient({ baseUrl: url });
    const { ok, result, trace } = await wrapCall(fn, { endpoint: 'chat', model: 'gpt-4o-mini' }, client);
    assert.equal(ok, true);
    assert.equal(result.usage.total_tokens, 12);
    assert.equal(trace.tokensTotal, 12);
    assert.equal(trace.endpoint, 'chat');
    assert.ok(trace.latencyMs >= 0);
  });
  await t.test('wrapCall error', async () => {
    const fn = async () => { throw Object.assign(new Error('boom'), { name: 'BoomError', status: 429 }); };
    const client = createIngestClient({ baseUrl: url });
    const { ok, error, trace } = await wrapCall(fn, { endpoint: 'chat' }, client);
    assert.equal(ok, false);
    assert.ok(error);
    assert.equal(trace.ok, false);
    assert.equal(trace.errType, 'BoomError');
    assert.equal(trace.status, 429);
  });
  server.close();
});

test('sdk: honors api key', async (t) => {
  // Start server with env var set requires re-import, but we cannot easily rewire here.
  // Instead, simulate by injecting header and expecting 401 when server expects a key.
  process.env.INGEST_API_KEY = 'secret';
  const { server, url } = await startServer();
  await t.test('missing key => 401', async () => {
    const client = createIngestClient({ baseUrl: url });
    let threw = false;
    try { await client.recordTrace({ ts: Date.now(), endpoint: 'x', ok: true, latencyMs: 1 }); } catch (e) { threw = true; }
    assert.equal(threw, true);
  });
  await t.test('with key => ok', async () => {
    const client = createIngestClient({ baseUrl: url, apiKey: 'secret' });
    await client.recordTrace({ ts: Date.now(), endpoint: 'x', ok: true, latencyMs: 1 });
  });
  server.close();
  delete process.env.INGEST_API_KEY;
});
