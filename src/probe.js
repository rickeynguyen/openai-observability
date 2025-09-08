import fetch from 'node-fetch';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';

const cfgSchema = z.object({
  OPENAI_API_KEY: z.string().min(8),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  PROBE_REGION: z.string().default('us-west-1'),
  HTTP_TIMEOUT_MS: z.string().default('12000'),
  PROBE_ENDPOINTS: z.string().optional(), // comma-separated keys; if unset use defaults
  PROBE_HEAVY: z.string().optional(), // '1' to enable heavy probes like images/audio
  PROBE_MODE: z.string().optional(), // 'roundrobin' (default) or 'all'
  OPENAI_EMBEDDINGS_MODEL: z.string().optional(), // override embeddings model
  OPENAI_MODERATION_MODEL: z.string().optional(), // override moderation model
});

export class ProbeRunner {
  constructor({ store, intervalSec, model, db, persist = true }) {
    this.store = store;
    this.intervalSec = intervalSec;
    this.model = model;
    this.timer = null;
    this.db = db;
    this.persist = persist;
    this._rrIndex = 0;
    this._prepared = null; // cached prepared probes after reading env
  this._ticks = 0;
  this._lastTickAt = null;
  }

  start() {
    if (this.timer) return;
    if (!process.env.OPENAI_API_KEY) {
      console.warn('[probe] OPENAI_API_KEY missing; probe disabled until provided');
      return;
    }
    // Prepare and log config
    try {
      const env = cfgSchema.parse(process.env);
      this._prepared = this._getProbeDefs(env);
      const mode = (env.PROBE_MODE || 'roundrobin').toLowerCase();
      const heavy = env.PROBE_HEAVY === '1' || env.PROBE_HEAVY === 'true';
      console.log(`[probe] interval=${this.intervalSec}s mode=${mode} heavy=${heavy} endpoints=${this._prepared.map(d=>d.key).join(', ')}`);
    } catch (e) {
      console.warn('[probe] env parse failed; using defaults', e.message);
    }
    // Immediate kick runs first target; then interval
    this.runTick().catch(() => {});
    this.timer = setInterval(() => this.runTick().catch(() => {}), this.intervalSec * 1000);
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  _getProbeDefs(env) {
    const heavyEnabled = env.PROBE_HEAVY === '1' || env.PROBE_HEAVY === 'true';
    const embedModel = env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-small';
    const modModel = env.OPENAI_MODERATION_MODEL || 'omni-moderation-latest';
    // Top 10 showcase (heavy marked):
    const defs = [
      {
        key: 'chat', endpoint: '/v1/chat/completions', method: 'POST', heavy: false,
        buildBody: (env) => ({ model: this.model || env.OPENAI_MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, temperature: 0 })
      },
      {
        key: 'responses', endpoint: '/v1/responses', method: 'POST', heavy: false,
        buildBody: (env) => ({ model: this.model || env.OPENAI_MODEL, input: 'ping' })
      },
      {
        key: 'embeddings', endpoint: '/v1/embeddings', method: 'POST', heavy: false,
        buildBody: () => ({ model: embedModel, input: 'ping' })
      },
      {
        key: 'moderations', endpoint: '/v1/moderations', method: 'POST', heavy: false,
        buildBody: () => ({ model: modModel, input: 'I love you' })
      },
      { key: 'models', endpoint: '/v1/models', method: 'GET', heavy: false },
      { key: 'files', endpoint: '/v1/files', method: 'GET', heavy: false },
      { key: 'fine_tunes', endpoint: '/v1/fine_tuning/jobs', method: 'GET', heavy: false },
      { key: 'batches', endpoint: '/v1/batches', method: 'GET', heavy: false },
      { key: 'assistants', endpoint: '/v1/assistants', method: 'GET', heavy: false },
      // Heavy (opt-in): images generation
      {
        key: 'images', endpoint: '/v1/images/generations', method: 'POST', heavy: true,
        buildBody: () => ({ model: 'gpt-image-1', prompt: 'a small red dot on white background', size: '256x256', n: 1 })
      },
    ];
    // Filter by configured keys
    let keys = env.PROBE_ENDPOINTS ? env.PROBE_ENDPOINTS.split(',').map(s => s.trim()).filter(Boolean) : null;
    let filtered = defs.filter(d => keys ? keys.includes(d.key) : true);
    if (!heavyEnabled) filtered = filtered.filter(d => !d.heavy);
    if (filtered.length === 0) {
      // fallback to chat only
      filtered = [defs[0]];
    }
    return filtered;
  }

  async runTick() {
    let env;
    try {
      env = cfgSchema.parse(process.env);
    } catch (e) {
      // configuration error
      this.store.push({ ts: Date.now(), ok: false, status: 0, latencyMs: 0, endpoint: '/v1/chat/completions', model: this.model, region: process.env.PROBE_REGION || 'unknown', errType: 'config' });
      return;
    }
  this._ticks += 1;
  this._lastTickAt = Date.now();
  console.log(`[probe] tick #${this._ticks} @ ${new Date(this._lastTickAt).toISOString()}`);
    const mode = (env.PROBE_MODE || 'roundrobin').toLowerCase();
    const defs = this._prepared || (this._prepared = this._getProbeDefs(env));
    if (mode === 'all') {
      // Run sequentially to avoid burst
      for (const def of defs) {
        await this._runProbe(def, env).catch(() => {});
      }
    } else {
      // round-robin single probe per tick
      const def = defs[this._rrIndex % defs.length];
      this._rrIndex = (this._rrIndex + 1) % defs.length;
      await this._runProbe(def, env).catch(() => {});
    }
  }

  async _runProbe(def, env) {
    const { OPENAI_API_KEY, OPENAI_MODEL, PROBE_REGION } = env;
    const endpoint = def.endpoint;
    const url = 'https://api.openai.com' + endpoint;
    const controller = new AbortController();
    const timeoutMs = Number(env.HTTP_TIMEOUT_MS);
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = performance.now();
    let ok = false, status = 0, errType = null;
    let usage = null; let respBytes = null;
    try {
  console.log(`[probe] -> ${def.key} ${def.method} ${endpoint}`);
      const init = {
        method: def.method,
        signal: controller.signal,
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      };
      if (def.method === 'POST') {
        init.headers['Content-Type'] = 'application/json';
        const body = def.buildBody ? def.buildBody(env) : {};
        init.body = JSON.stringify(body);
      }
      const res = await fetch(url, init);
      status = res.status;
      ok = res.ok;
      const text = await res.text();
      respBytes = Buffer.byteLength(text || '', 'utf8');
      if (res.ok) {
        try { const json = JSON.parse(text); usage = json.usage || null; } catch (_) {}
      }
    } catch (e) {
      errType = e.name === 'AbortError' ? 'timeout' : 'network';
    } finally {
      clearTimeout(t);
      const dt = Math.round(performance.now() - t0);
      console.log(`[probe] <- ${def.key} status=${status} ok=${ok} dt=${dt}ms err=${errType||''}`);
      const point = { ts: Date.now(), ok, status, latencyMs: dt, endpoint, model: this.model || OPENAI_MODEL, region: PROBE_REGION, errType,
        tokensTotal: usage?.total_tokens ?? null,
        tokensPrompt: usage?.prompt_tokens ?? null,
        tokensCompletion: usage?.completion_tokens ?? null,
        respBytes: respBytes };
      this.store.push(point);
      if (this.db && this.persist) {
        const { insertProbe } = await import('./db.js');
        insertProbe(this.db, point);
      }
    }
  }

  getConfig() {
    let env;
    try { env = cfgSchema.parse(process.env); } catch (_) { env = {}; }
    const defs = this._prepared || this._getProbeDefs(env);
    return {
      intervalSec: this.intervalSec,
      model: this.model || env.OPENAI_MODEL,
      region: env.PROBE_REGION || 'unknown',
      mode: (env.PROBE_MODE || 'roundrobin').toLowerCase(),
      heavy: env.PROBE_HEAVY === '1' || env.PROBE_HEAVY === 'true',
  endpoints: defs.map(d => ({ key: d.key, method: d.method, endpoint: d.endpoint, heavy: !!d.heavy })),
  ticks: this._ticks,
  lastTickAt: this._lastTickAt
    };
  }
}
