import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsStore } from '../src/metricsStore.js';

test('MetricsStore aggregates percentiles and errors', () => {
  const store = new MetricsStore({ capacity: 50 });
  const now = Date.now();
  const latencies = [10,20,30,40,50];
  latencies.forEach(ms => store.push({ ts: now, ok: true, status: 200, latencyMs: ms, endpoint: '/v1/chat/completions', model: 'm', region: 'r', errType: null }));
  store.push({ ts: now, ok: false, status: 500, latencyMs: 5, endpoint: '/v1/chat/completions', model: 'm', region: 'r', errType: 'network' });
  const summary = store.summary({ windowMinutes: 5 });
  const ep = summary.endpoints['/v1/chat/completions'];
  assert.equal(ep.total, 6);
  assert.equal(ep.ok, 5);
  assert.ok(ep.successRate > 0.8 && ep.successRate < 1);
  assert.equal(ep.latencyMs.p50, 30);
  assert.equal(ep.latencyMs.p95, 50); // with small sample p95==max
  assert.equal(ep.latencyMs.p99, 50);
  assert.equal(ep.errors.network, 1);
});
