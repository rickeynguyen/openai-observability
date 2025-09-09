import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { app } from '../src/server.js';

// Minimal sanity check for /ai/chat without LLM and without DB
// Ensures endpoint responds 200 with an answer field

test('POST /ai/chat returns a summary answer (no-LLM PoC)', async () => {
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, res));
  const port = server.address().port;
  const body = { messages: [{ role: 'user', content: 'What is the reliability right now?' }], llm: false };
  const res = await fetch(`http://127.0.0.1:${port}/ai/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.ok(typeof j.answer === 'string');
  server.close();
});
