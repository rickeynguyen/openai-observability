// Load .env in non-test environments to avoid leaking local keys into test runs
if (process.env.NODE_ENV !== 'test') {
  try { await import('dotenv/config'); } catch {}
}
import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MetricsStore } from './metricsStore.js';
import { normalizeTrace } from './schemas.js';
import { initOTel } from './otel.js';
import { ProbeRunner } from './probe.js';
import fetch from 'node-fetch';
let fetchWindow = null;
let fetchRange = null;
let db = null;
let dbInitError = null;
const enableDb = process.env.ENABLE_DB === '1' || process.env.ENABLE_DB === 'true';
if (process.env.NODE_ENV !== 'test' && enableDb) {
  try {
    const dbMod = await import('./db.js');
  fetchWindow = dbMod.fetchWindow;
  fetchRange = dbMod.fetchRange; // Added fetchRange import
    db = dbMod.openDb();
    // Ensure AI logs schema if AI enabled
    if ((process.env.ENABLE_AI === '1' || process.env.ENABLE_AI === 'true') && dbMod.ensureLogsSchema) {
      try { dbMod.ensureLogsSchema(db); } catch(e) { console.warn('[db] logs schema init failed', e.message); }
    }
  // Ensure synthetics schema
  try { dbMod.ensureSynthSchema?.(db); } catch(e) { console.warn('[db] synth schema init failed', e.message); }
  // Logging helper initialized below; temporary console fallback will be replaced once log object defined
  console.log('[db] sqlite ready');
  } catch (e) {
  dbInitError = e;
  console.warn('[db] sqlite init failed', e.message);
  }
} else if (!enableDb) {
  console.log('[db] disabled (set ENABLE_DB=1 to enable persistence)');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(express.json({ limit: '1mb' }));

// --- Logging setup (LOG_LEVEL: error|warn|info|debug) ---
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LEVELS = { error:0, warn:1, info:2, debug:3 };
function should(level){ return (LEVELS[level] ?? 2) <= (LEVELS[LOG_LEVEL] ?? 2); }
const log = {
  error: (...a)=>{ if(should('error')) console.error(...a); },
  warn:  (...a)=>{ if(should('warn'))  console.warn(...a); },
  info:  (...a)=>{ if(should('info'))  console.log(...a); },
  debug: (...a)=>{ if(should('debug')) console.log(...a); },
};
// Replace earlier bootstrap console logs with leveled versions (cannot retroactively change already emitted lines)
// Request logger: only log successes at debug level; always log 4xx/5xx at warn.
app.use((req,res,next)=>{ const start=Date.now(); res.on('finish',()=>{ const ms=Date.now()-start; if(res.statusCode>=400) log.warn(`[http] ${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms`); else if(should('debug')) log.debug(`[http] ${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms`); }); next(); });

// Metrics store & OTel init
export const store = new MetricsStore({ capacity: 1000 });
initOTel({ store });

// Simple Server-Sent Events (SSE) broadcaster
const sseClients = new Set();
function sseWrite(res, payload, eventName = 'trace') {
  try {
    if (eventName) res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (_) {}
}
function broadcastTrace(point) {
  if (!sseClients.size) return;
  for (const res of sseClients) sseWrite(res, { ts: point.ts, endpoint: point.endpoint, ok: !!point.ok, latencyMs: point.latencyMs, status: point.status, model: point.model, region: point.region });
}
// override store.push to also broadcast
const _origPush = store.push.bind(store);
store.push = (point) => { _origPush(point); broadcastTrace(point); };

// Helper: extract assistant text from the Responses API JSON (handles multiple shapes)
function extractResponsesText(j) {
  try {
    if (!j) return null;
    if (typeof j.output_text === 'string' && j.output_text.trim()) return j.output_text;
    if (Array.isArray(j.output)) {
      const parts = [];
      for (const item of j.output) {
        const content = item && Array.isArray(item.content) ? item.content : null;
        if (!content) continue;
        for (const c of content) {
          const t = typeof c?.text === 'string' ? c.text : (typeof c?.output_text === 'string' ? c.output_text : null);
          if (t) parts.push(t);
        }
      }
      const s = parts.join('').trim();
      if (s) return s;
    }
    // Some SDKs may nest under response
    if (j.response) {
      const t = extractResponsesText(j.response);
      if (t) return t;
    }
    // Very old/alternate shapes
    if (Array.isArray(j.content)) {
      const parts = [];
      for (const c of j.content) {
        if (typeof c?.text === 'string') parts.push(c.text);
      }
      const s = parts.join('').trim();
      if (s) return s;
    }
  } catch (_) {}
  return null;
}
// Helper: extract text from Chat Completions API JSON
function extractChatCompletionsText(j){
  try {
    const c = j?.choices?.[0];
    if (c?.message?.content) return c.message.content;
    if (Array.isArray(c?.messages) && c.messages[0]?.content) return c.messages[0].content; // rare shapes
  } catch(_){ }
  return null;
}

// Probe setup
const intervalSec = Number(process.env.PROBE_INTERVAL_SEC || '60');
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const region = process.env.PROBE_REGION || 'us-west-1';
const probe = new ProbeRunner({ store, intervalSec, model, db, persist: !!db });
export { probe };
// Auto-start probe only outside test to avoid external network calls interfering with test runner
if (process.env.NODE_ENV !== 'test') {
  try { probe.start(); } catch(_){ }
}

// Prevent caching of API responses
app.use((req, res, next) => {
  if (req.path.startsWith('/status') || req.path.startsWith('/traces') || req.path.startsWith('/latency_histogram') || req.path.startsWith('/debug') || req.path.startsWith('/incidents')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Routes
app.get('/events', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();
  // initial hello
  sseWrite(res, { hello: true, now: Date.now() }, 'hello');
  sseClients.add(res);
  req.on('close', () => { sseClients.delete(res); try { res.end(); } catch(_){} });
});

// heartbeat to keep connections alive (skip during tests)
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    if (!sseClients.size) return;
    for (const res of sseClients) sseWrite(res, { now: Date.now() }, 'ping');
  }, 15000);
}
app.get('/debug/probe', (req, res) => {
  try {
    const cfg = probe.getConfig();
    const last = store.points.slice(-50);
    res.json({ config: cfg, lastPoints: last });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ===== AI-centric Observability: Logs, Embeddings, Search =====
const ENABLE_AI = process.env.ENABLE_AI === '1' || process.env.ENABLE_AI === 'true';
const INGEST_KEY = process.env.INGEST_API_KEY || process.env.INGEST_TOKEN || '';
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const LOG_SIM_ENABLED = process.env.LOG_SIM_ENABLED === '1' || process.env.LOG_SIM_ENABLED === 'true';
const LOG_SIM_INTERVAL_MS = Number(process.env.LOG_SIM_INTERVAL_MS || 30000);
const EMB_INDEX_INTERVAL_MS = Number(process.env.EMB_INDEX_INTERVAL_MS || 45000);

function noStore(res){res.set('Cache-Control','no-store');}
function requireIngestKey(req,res,next){
  if (!INGEST_KEY) return res.status(400).json({ error:'INGEST_API_KEY not set' });
  const tok = req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i,'');
  if (tok===INGEST_KEY) return next();
  console.warn(`[auth] unauthorized for ${req.method} ${req.originalUrl} (has_key=${Boolean(tok)})`);
  return res.status(401).json({ error:'unauthorized' });
}

// Public, non-sensitive config for the UI (no secrets)
app.get('/config', (req, res) => {
  noStore(res);
  try {
    res.json({
      enableDb: !!db,
      enableAi: ENABLE_AI,
      logSimEnabled: LOG_SIM_ENABLED,
      logSimIntervalMs: LOG_SIM_INTERVAL_MS,
      embIndexIntervalMs: EMB_INDEX_INTERVAL_MS,
      ingestKeyConfigured: !!INGEST_KEY,
      dbInitError: db ? null : (dbInitError ? String(dbInitError.message||dbInitError) : null),
      synthetics: { enabled: true },
      probe: { intervalSec: probe.intervalSec, model, region },
      // Provide a curated list of commonly used OpenAI models for UI dropdown; safe (no secrets)
      models: [
        'gpt-4.1-mini',
        'gpt-4.1',
        'gpt-4o-mini',
        'gpt-4o',
        'gpt-4.1-nano',
        'chatgpt-4o-latest',
        'gpt-5',
        'gpt-5-mini',
        'gpt-5-nano'
      ]
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message||e) });
  }
});

// Runtime update of probe interval (allowed values: 60, 300, 600, 900 seconds)
app.post('/probe/interval', (req, res) => {
  try {
    const allowed = [60, 300, 600, 900];
    const bodyVal = req.body && (req.body.intervalSec ?? req.body.interval);
    const qVal = req.query.intervalSec || req.query.interval;
    const raw = bodyVal != null ? bodyVal : qVal;
    const next = Number(raw);
    if (!allowed.includes(next)) {
      return res.status(400).json({ error: 'invalid_interval', allowed });
    }
    if (probe.intervalSec === next) {
      return res.json({ updated: false, intervalSec: probe.intervalSec });
    }
    probe.stop();
    probe.intervalSec = next;
    if (process.env.NODE_ENV !== 'test') probe.start();
    res.json({ updated: true, intervalSec: probe.intervalSec });
  } catch (e) {
    res.status(500).json({ error: String(e?.message||e) });
  }
});

// Minimal env debug (sanitized) to help diagnose deployment config mismatches
app.get('/debug/env', (req,res)=>{
  try {
    const pick = (k)=> process.env[k];
    const mask = (v)=> v ? (v.length<=8? '*'.repeat(v.length) : v.slice(0,2)+'***'+v.slice(-2)) : '';
    res.json({
      ENABLE_DB: pick('ENABLE_DB') || null,
      DB_FILE: pick('DB_FILE') || null,
      ENABLE_AI: pick('ENABLE_AI') || null,
      PROBE_INTERVAL_SEC: pick('PROBE_INTERVAL_SEC') || null,
      PROBE_REGION: pick('PROBE_REGION') || null,
      OPENAI_MODEL: pick('OPENAI_MODEL') || null,
      LOG_SIM_ENABLED: pick('LOG_SIM_ENABLED') || null,
      LOG_SIM_INTERVAL_MS: pick('LOG_SIM_INTERVAL_MS') || null,
      EMB_INDEX_INTERVAL_MS: pick('EMB_INDEX_INTERVAL_MS') || null,
      INGEST_API_KEY_present: !!pick('INGEST_API_KEY'),
      INGEST_API_KEY_sample: pick('INGEST_API_KEY') ? mask(pick('INGEST_API_KEY')) : null,
      PID: process.pid,
      startedAt: new Date().toISOString()
    });
  } catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// logs ingestion (NDJSON or JSON array)
app.post('/logs/ingest', async (req, res) => {
  noStore(res);
  if (!ENABLE_AI) return res.status(400).json({ error:'ENABLE_AI=1 required' });
  if (!enableDb || !db) return res.status(400).json({ error:'ENABLE_DB=1 required' });
  if (!INGEST_KEY) return res.status(400).json({ error:'INGEST_API_KEY not set' });
  const tok = req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i,'');
  if (tok !== INGEST_KEY) return res.status(401).json({ error:'unauthorized' });
  try {
    const ct = String(req.headers['content-type']||'');
    let items = [];
    if (ct.includes('ndjson') || ct.includes('text/plain')) {
      const chunks=[];for await (const ch of req) chunks.push(ch);
      const text=Buffer.concat(chunks).toString('utf8');
      items = text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(l=>JSON.parse(l));
    } else {
      items = Array.isArray(req.body)?req.body:(req.body?.items||[]);
    }
    if (!items.length) return res.status(400).json({ error:'no items' });
    const { insertLogs } = await import('./db.js');
    const ids = insertLogs(db, items);
    res.json({ inserted: ids.length, ids });
  } catch(e){
    console.error('[logs/ingest]', e);
    res.status(400).json({ error:'invalid payload', detail: String(e?.message||e) });
  }
});

// simulator
let logSimTimer = null;
function generateSyntheticLogs(count=10){
  const endpoints=['/v1/chat/completions','/v1/responses','/v1/embeddings','/v1/moderations','/v1/models','/v1/files','/v1/batches','/v1/assistants'];
  const models=['gpt-4o-mini','gpt-4.1-nano','text-embedding-3-small','omni-moderation-latest'];
  const regions=['us-west-1','us-east-1','eu-west-1'];
  const out=[];const now=Date.now();
  for(let i=0;i<count;i++){
    const ep=endpoints[Math.floor(Math.random()*endpoints.length)];
    const model=models[Math.floor(Math.random()*models.length)];
    const region=regions[Math.floor(Math.random()*regions.length)];
    let latency=Math.max(20,Math.round(400+(Math.random()-0.5)*200));
    if (Math.random()<0.08) latency += 800 + Math.random()*1200;
    let status=200, err_type=null; const r=Math.random();
    if (r<0.02){status=500;err_type='server_error';}
    else if (r<0.05){status=429;err_type='rate_limit';}
    else if (r<0.08){status=400;err_type='invalid_request';}
    let tokens_prompt=null,tokens_completion=null,tokens_total=null;
    if (ep==='/v1/chat/completions'||ep==='/v1/responses'){tokens_prompt=Math.floor(10+Math.random()*30);tokens_completion=status===200?Math.floor(5+Math.random()*20):0;tokens_total=tokens_prompt+tokens_completion;}
    else if (ep==='/v1/embeddings'){tokens_prompt=Math.floor(5+Math.random()*8);tokens_total=tokens_prompt;}
    const reqId=Math.random().toString(16).slice(2,10);
    const text=`request_id=${reqId} path=${ep} status=${status} model=${model} region=${region} latency=${latency}ms err=${err_type||'none'}`;
    out.push({ ts: now - Math.floor(Math.random()*30000), endpoint: ep, model, region, level: status>=500?'error':status>=400?'warn':'info', status, latency_ms: latency, tokens_prompt, tokens_completion, tokens_total, err_type, text });
  }
  return out;
}

async function startLogSimulator(res){
  if (logSimTimer) return res.json({ running:true });
  const { insertLogs } = await import('./db.js');
  logSimTimer = setInterval(()=>{
    try { const batch=generateSyntheticLogs(5+Math.floor(Math.random()*20)); insertLogs(db,batch); } catch(e){ console.warn('[logs/sim]', e.message); }
  }, LOG_SIM_INTERVAL_MS);
  log.info(`[logs/sim] started ${LOG_SIM_INTERVAL_MS}ms`);
  return res.json({ started:true, intervalMs: LOG_SIM_INTERVAL_MS });
}
app.get('/logs/sim/start', requireIngestKey, async (req,res)=>{
  noStore(res);
  if (!ENABLE_AI) return res.status(400).json({ error:'ENABLE_AI=1 required' });
  if (!enableDb || !db) return res.status(400).json({ error:'ENABLE_DB=1 required' });
  return startLogSimulator(res);
});
// POST alias (frontend auto-start previously used POST causing 404) – keep for backward compatibility
app.post('/logs/sim/start', requireIngestKey, async (req,res)=>{
  noStore(res);
  if (!ENABLE_AI) return res.status(400).json({ error:'ENABLE_AI=1 required' });
  if (!enableDb || !db) return res.status(400).json({ error:'ENABLE_DB=1 required' });
  return startLogSimulator(res);
});

app.get('/logs/sim/stop', requireIngestKey, (req,res)=>{
  noStore(res);
  if (logSimTimer){ clearInterval(logSimTimer); logSimTimer=null; log.info('[logs/sim] stopped'); }
  res.json({ stopped:true });
});

// Simulator status
app.get('/logs/sim/status', requireIngestKey, (req,res)=>{
  noStore(res);
  res.json({ running: !!logSimTimer, intervalMs: LOG_SIM_INTERVAL_MS });
});

if (LOG_SIM_ENABLED && process.env.NODE_ENV !== 'test') {
  setTimeout(async ()=>{
    if (!enableDb || !db) return; if (logSimTimer) return;
    const { insertLogs } = await import('./db.js');
    logSimTimer = setInterval(()=>{ try{ insertLogs(db, generateSyntheticLogs(10)); }catch{} }, LOG_SIM_INTERVAL_MS);
  log.debug(`[logs/sim] auto-started ${LOG_SIM_INTERVAL_MS}ms`);
  }, 1500);
}

async function embedTexts(texts, model, apiKey){
  const r = await fetch('https://api.openai.com/v1/embeddings', { method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${apiKey}` }, body: JSON.stringify({ model, input: texts }) });
  if (!r.ok){ const t=await r.text(); throw new Error(`embed failed ${r.status}: ${t}`); }
  const j = await r.json();
  return j.data.map(d=>d.embedding);
}

app.post('/ai/index/logs', async (req,res)=>{
  noStore(res);
  if (!ENABLE_AI) return res.status(400).json({ error:'ENABLE_AI=1 required' });
  if (!enableDb || !db) return res.status(400).json({ error:'ENABLE_DB=1 required' });
  const apiKey = process.env.OPENAI_API_KEY; if (!apiKey) return res.status(400).json({ error:'OPENAI_API_KEY required' });
  log.info('[ai/index/logs] starting');
  const limit = Math.min(64, Number(req.query.limit || 32));
  const sinceTs = req.query.since ? Number(req.query.since) : null;
  try{
    const { selectLogsNeedingEmbedding, upsertLogEmbedding } = await import('./db.js');
    const rows = selectLogsNeedingEmbedding(db, limit, sinceTs);
    if (!rows.length) return res.json({ indexed:0, dim:null });
    const vecs = await embedTexts(rows.map(r=>r.text), EMBEDDING_MODEL, apiKey);
    const dim = vecs[0]?.length || 0;
    const trx = db.transaction((items, embeddings)=>{ items.forEach((r,i)=> upsertLogEmbedding(db, r.id, embeddings[i], dim)); });
    trx(rows, vecs);
    res.json({ indexed: rows.length, dim });
  } catch(e){ console.error('[ai/index/logs]', e.message); res.status(500).json({ error: e.message }); }
});

// Auto-indexing: periodically index logs needing embeddings
let embedIndexTimer = null;
app.get('/ai/index/auto/start', requireIngestKey, async (req,res)=>{
  noStore(res);
  if (!ENABLE_AI) return res.status(400).json({ error:'ENABLE_AI=1 required' });
  if (!enableDb || !db) return res.status(400).json({ error:'ENABLE_DB=1 required' });
  const apiKey = process.env.OPENAI_API_KEY; if (!apiKey) return res.status(400).json({ error:'OPENAI_API_KEY required' });
  if (embedIndexTimer) return res.json({ running:true, intervalMs: EMB_INDEX_INTERVAL_MS });
  const tick = async () => {
    try{
      const { selectLogsNeedingEmbedding, upsertLogEmbedding } = await import('./db.js');
      const rows = selectLogsNeedingEmbedding(db, 64, null);
      if (!rows.length) return;
      const vecs = await embedTexts(rows.map(r=>r.text), EMBEDDING_MODEL, apiKey);
      const dim = vecs[0]?.length || 0;
      const trx = db.transaction((items, embeddings)=>{ items.forEach((r,i)=> upsertLogEmbedding(db, r.id, embeddings[i], dim)); });
      trx(rows, vecs);
  log.debug(`[ai/index/auto] indexed ${rows.length}`);
    }catch(e){ console.warn('[ai/index/auto] tick failed', e.message); }
  };
  embedIndexTimer = setInterval(tick, EMB_INDEX_INTERVAL_MS);
  log.info(`[ai/index/auto] started ${EMB_INDEX_INTERVAL_MS}ms`);
  res.json({ started:true, intervalMs: EMB_INDEX_INTERVAL_MS });
});

app.get('/ai/index/auto/stop', requireIngestKey, (req,res)=>{
  noStore(res);
  if (embedIndexTimer){ clearInterval(embedIndexTimer); embedIndexTimer=null; log.info('[ai/index/auto] stopped'); }
  res.json({ stopped:true });
});

app.get('/ai/index/auto/status', requireIngestKey, (req,res)=>{
  noStore(res);
  res.json({ running: !!embedIndexTimer, intervalMs: EMB_INDEX_INTERVAL_MS });
});

// ===== Synthetic Monitors (AI-assisted) =====
const synthMonitors = [];
const synthRuns = [];
let synthNextId = 1;
let synthRunNextId = 1;
const SCHEDULE_MINUTES = { manual:0, every_1m:1, every_5m:5, every_10m:10, every_15m:15, every_30m:30, hourly:60 };
const synthScheduleState = new Map(); // id -> { nextDueAt:number }
const synthRunning = new Set();

// Small helpers to guard dynamic imports usage so earlier code referring to db.getSynthMonitor doesn't break
// (Original code tried db.getSynthMonitor which was undefined; we now centralize access.)
async function loadDbFns(){
  if (!db) return {};
  try { return await import('./db.js'); } catch { return {}; }
}

function normalizeSynthSpec(spec){
  // sanitize schedule
  const schedRaw = String(spec?.schedule || 'manual').toLowerCase();
  const schedule = Object.prototype.hasOwnProperty.call(SCHEDULE_MINUTES, schedRaw) ? schedRaw : 'manual';
  const out = {
    name: String(spec?.name || 'Synthetic Monitor'),
    schedule,
    startUrl: String(spec?.startUrl || spec?.url || ''),
    timeoutMs: Number(spec?.timeoutMs || 30000),
    steps: Array.isArray(spec?.steps) ? spec.steps : [],
    auth: spec?.auth && typeof spec.auth === 'object' ? {
      headers: (spec.auth.headers && typeof spec.auth.headers === 'object') ? spec.auth.headers : undefined,
      cookies: Array.isArray(spec.auth.cookies) ? spec.auth.cookies.map(c=>({
        name: String(c?.name||''),
        value: String(c?.value||''),
        domain: c?.domain ? String(c.domain) : undefined,
        path: c?.path ? String(c.path) : undefined,
        httpOnly: !!c?.httpOnly,
        secure: !!c?.secure,
        sameSite: c?.sameSite ? String(c.sameSite) : undefined
      })).filter(x=>x.name && x.value) : undefined
    } : undefined
  };
  // Trim accidental trailing period in URL (common copy/paste typo -> 403 / DNS issues)
  if (out.startUrl && out.startUrl.endsWith('.')) out.startUrl = out.startUrl.slice(0,-1);
  out.steps = out.steps.map(s=>{
    const step = {
      action: String(s?.action||'').toLowerCase(),
      url: s?.url ? String(s.url) : undefined,
      selector: s?.selector ? String(s.selector) : undefined,
      text: s?.text != null ? String(s.text) : undefined,
      enter: s?.enter ? true : false,
      timeoutMs: s?.timeoutMs!=null ? Number(s.timeoutMs) : undefined,
      any: s?.any ? true : false,
      ms: s?.ms!=null ? Number(s.ms) : undefined,
      soft: s?.soft ? true : false,
      pollMs: s?.pollMs!=null ? Number(s.pollMs) : undefined,
      retryMs: s?.retryMs!=null ? Number(s.retryMs) : undefined,
      id: s?.id ? String(s.id) : undefined
    };
    // Preserve any additional custom keys (future-proof) except ones we already set / sanitized
    for(const k of Object.keys(s||{})) if(!(k in step)) step[k]=s[k];
    return step;
  }).filter(s=>s.action);
  return out;
}

function ensureStepIds(spec){
  try{
    if (spec && Array.isArray(spec.steps)) {
      for (const s of spec.steps) { if (!s.id) s.id = Math.random().toString(36).slice(2,10); }
    }
  }catch(_){ }
  return spec;
}

async function ensureSynthDir(){
  const dir = path.join(__dirname, '../public/synth');
  try { await fs.mkdir(dir, { recursive: true }); } catch(_){ }
  return dir;
}

// Draft monitor spec using LLM
app.post('/synthetics/draft', async (req, res) => {
  noStore(res);
  try{
    const prompt = String(req.body?.prompt||'').trim();
    if(!prompt) return res.status(400).json({ error:'prompt required' });
    if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error:'OPENAI_API_KEY required for drafting' });
    const sys = `You are a test designer that outputs ONLY JSON for a headless browser synthetic test DSL. No prose. The JSON schema:\n{
  "name": string,
  "schedule": "manual" | "every_1m" | "every_5m" | "every_10m" | "every_15m" | "every_30m" | "hourly",
  "startUrl": string,
  "timeoutMs": number,
  "steps": Array<{
    action: "goto" | "click" | "type" | "waitFor" | "assertTextContains",
    url?: string,
    selector?: string,
    text?: string,
    enter?: boolean,
    timeoutMs?: number,
    any?: boolean
  }>,
  "auth"?: {
    headers?: { [key: string]: string },
    cookies?: Array<{ name: string, value: string, domain?: string, path?: string, httpOnly?: boolean, secure?: boolean, sameSite?: "Lax"|"Strict"|"None" }>
  }
}\nRules: Prefer robust CSS selectors (textarea, input[type=\"text\"], button, [role=\"button\"], etc). For \"type\", include selector and text. If pressing enter is needed, set enter: true. For assertions, include a broad selector like \"body\". If a site requires login, you may include simple cookie-based auth in the auth.cookies array. Output ONLY the JSON.`;
    const user = `Create a synthetic test for: ${prompt}`;
    const r = await fetch('https://api.openai.com/v1/responses', {
      method:'POST', headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini', input:[
        { role:'system', content:[{ type:'input_text', text: sys }] },
        { role:'user', content:[{ type:'input_text', text: user }] }
      ], max_output_tokens: 600, temperature: 0 })
    });
    if(!r.ok){ const t=await r.text(); return res.status(500).json({ error:'llm_failed', detail:t }); }
    const j = await r.json();
    const outText = extractResponsesText(j) || '';
    let specObj = null;
    try { specObj = JSON.parse(outText); } catch(_){ }
    if(!specObj || !specObj.steps){
      const urlMatch = prompt.match(/https?:\/\/\S+/);
      const url = urlMatch ? urlMatch[0] : 'https://example.com';
      specObj = { name:'Synthetic Test', schedule:'manual', startUrl:url, timeoutMs:20000, steps:[ { action:'goto', url }, { action:'assertTextContains', selector:'body', text:'', any:true } ] };
    }
  const spec = normalizeSynthSpec(specObj);
    res.json({ spec });
  }catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// Create monitor
app.post('/synthetics', async (req,res)=>{
  noStore(res);
  try{
  let spec = normalizeSynthSpec(req.body?.spec||{}); ensureStepIds(spec);
    if(!spec.startUrl && !spec.steps.some(s=>s.action==='goto' && s.url)) return res.status(400).json({ error:'startUrl or first goto step required' });
    const id = synthNextId++;
    const m = { id, name: spec.name || `Monitor ${id}`, spec, createdAt: Date.now() };
    // Persist if DB available
    if (db) {
      try { const { insertSynthMonitor } = await import('./db.js'); const rid = insertSynthMonitor(db, { name: m.name, spec: m.spec, schedule: m.spec.schedule, createdAt: m.createdAt }); if (typeof rid === 'number') m.id = rid; } catch(e){ console.warn('[synth] save monitor failed', e.message); }
    }
    synthMonitors.push(m);
    // seed schedule state
    try{
      const mins = SCHEDULE_MINUTES[m.spec.schedule] || 0; if (mins>0) synthScheduleState.set(m.id, { nextDueAt: Date.now() + mins*60000 });
    }catch(_){ }
    res.json({ id, monitor: m });
  }catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// List monitors
app.get('/synthetics', async (req,res)=>{
  noStore(res);
  try{
    if (db) {
  const { listSynthMonitors, getLastRunForMonitor } = await import('./db.js');
      const rows = listSynthMonitors(db);
  const showDeleted = req.query && String(req.query.deleted)==='1';
  const items = rows.filter(r=> showDeleted || !r.deleted).map(r=>{
        const last = getLastRunForMonitor(db, r.id);
        const mins = SCHEDULE_MINUTES[r.schedule] || 0;
        let nextDueAt = null;
        if (mins>0) {
          const state = synthScheduleState.get(r.id);
          if (state && state.nextDueAt) nextDueAt = state.nextDueAt;
          else {
            const seed = (last?.startedAt) || r.createdAt;
            nextDueAt = (seed||Date.now()) + mins*60000;
          }
        }
        // If spec has a more recent name (in-memory), reflect it
        let displayName = r.name;
        try {
          const mem = synthMonitors.find(m=>m.id===r.id);
          if (mem && mem.spec && mem.spec.name) displayName = mem.spec.name;
        } catch(_){}
        return {
          id: r.id,
          name: displayName,
          schedule: r.schedule,
          createdAt: r.createdAt,
          deleted: !!r.deleted,
          lastRun: last ? { startedAt: last.startedAt, ok: !!last.ok, statusText: last.statusText||'' } : null,
          nextDueAt
        };
      });
      return res.json({ items });
    }
  }catch(_){ }
  // In-memory fallback
  const items = synthMonitors.map(m=>{
    const schedule = m.spec?.schedule || 'manual';
    const mins = SCHEDULE_MINUTES[schedule] || 0;
    const last = synthRuns.find(r=>r.monitorId===m.id) || null;
    let nextDueAt = null;
    if (mins>0) {
      const state = synthScheduleState.get(m.id);
      if (state && state.nextDueAt) nextDueAt = state.nextDueAt;
      else {
        const seed = (last?.startedAt) || m.createdAt;
        nextDueAt = (seed||Date.now()) + mins*60000;
      }
    }
    return { id: m.id, name: m.name, createdAt: m.createdAt, schedule, lastRun: last? { startedAt: last.startedAt, ok: !!last.ok, statusText: last.statusText||'' } : null, nextDueAt };
  });
  res.json({ items });
});

// Update schedule
app.patch('/synthetics/:id/schedule', async (req, res)=>{
  noStore(res);
  try{
    const id = Number(req.params.id);
  let m = synthMonitors.find(x=>x.id===id);
  if(!m && db){ try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ m = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(m); } } catch(_){ } }
  if(!m) return res.status(404).json({ error:'not_found' });
    const schedRaw = String(req.body?.schedule||'').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(SCHEDULE_MINUTES, schedRaw)) return res.status(400).json({ error:'invalid_schedule' });
    m.spec.schedule = schedRaw;
  if (db){ try { const { updateSynthSchedule } = await import('./db.js'); updateSynthSchedule(db, id, schedRaw); } catch(_){ } }
    const mins = SCHEDULE_MINUTES[schedRaw] || 0;
    let nextDueAt = null;
    if (mins>0) {
      // Force immediate run then schedule next interval
      const now = Date.now();
      const state = { nextDueAt: now }; // will trigger immediate run via manual invocation below
      synthScheduleState.set(m.id, state);
      nextDueAt = state.nextDueAt;
      // Kick off run asynchronously (do not await to keep API snappy)
      (async ()=>{
        if (synthRunning.has(m.id)) return;
        synthRunning.add(m.id);
        try{
          const runId = synthRunNextId++;
          const startedAt = Date.now();
          const result = await runSyntheticMonitor(m.spec, runId);
          const rec = { id: runId, monitorId: m.id, startedAt, finishedAt: Date.now(), ok: !!result.ok, statusText: result.statusText||'', screenshot: result.screenshot||null, logs: result.logs||[], steps: result.steps||[] };
          synthRuns.unshift(rec);
          if (db){ try { const { insertSynthRun } = await import('./db.js'); insertSynthRun(db, rec); } catch(_){ } }
          // schedule subsequent run
          const mins2 = SCHEDULE_MINUTES[m.spec.schedule] || 0;
          if (mins2>0) synthScheduleState.set(m.id, { nextDueAt: Date.now() + mins2*60000 });
        }catch(e){
          const runId = synthRunNextId++;
          const rec = { id: runId, monitorId: m.id, startedAt: Date.now(), finishedAt: Date.now(), ok:false, statusText:'immediate_failed', screenshot:null, logs:[{ ts: Date.now(), msg: String(e?.message||e) }], steps: [] };
          synthRuns.unshift(rec);
          if (db){ try { const { insertSynthRun } = await import('./db.js'); insertSynthRun(db, rec); } catch(_){ } }
        } finally { synthRunning.delete(m.id); }
      })();
    } else {
      synthScheduleState.delete(m.id);
    }
    res.json({ id:m.id, schedule: m.spec.schedule, nextDueAt });
  }catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// Run a monitor once
// Replace entire monitor (name/spec) including steps (ids assigned if missing)
app.post('/synthetics/:id(\\d+)/run', async (req,res)=>{
  noStore(res);
  try {
    const id = Number(req.params.id);
    // Find monitor in memory or load from DB
    let m = synthMonitors.find(x=>x.id===id);
    if(!m && db){
      try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ m = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(m); } } catch(_){ }
    }
    if(!m) return res.status(404).json({ error:'not_found' });
    if (synthRunning.has(m.id)) return res.status(409).json({ error:'already_running' });
    const runId = synthRunNextId++;
    const startedAt = Date.now();
    synthRunning.add(m.id);
    // Fire and forget so client gets fast response
    (async ()=>{
      try {
        const result = await runSyntheticMonitor(m.spec, runId);
        const rec = { id: runId, monitorId: m.id, startedAt, finishedAt: Date.now(), ok: !!result.ok, statusText: result.statusText||'', screenshot: result.screenshot||null, logs: result.logs||[], steps: result.steps||[] };
        synthRuns.unshift(rec);
        if (db){ try { const { insertSynthRun } = await import('./db.js'); insertSynthRun(db, rec); } catch(_){ } }
      } catch(e){
        const rec = { id: runId, monitorId: m.id, startedAt, finishedAt: Date.now(), ok:false, statusText:String(e?.message||e), screenshot:null, logs:[{ ts: Date.now(), msg: 'run_failed: '+String(e?.message||e) }], steps: [] };
        synthRuns.unshift(rec);
        if (db){ try { const { insertSynthRun } = await import('./db.js'); insertSynthRun(db, rec); } catch(_){ } }
      } finally {
        synthRunning.delete(m.id);
        // If monitor has a schedule, only update nextDueAt if none exists (don't shift schedule forward on manual run)
        try {
          const sched = m.spec?.schedule || 'manual';
          const mins = SCHEDULE_MINUTES[sched] || 0;
          if (mins>0) {
            const state = synthScheduleState.get(m.id);
            if (!state || !state.nextDueAt) synthScheduleState.set(m.id, { nextDueAt: Date.now() + mins*60000 });
          }
        } catch(_){ }
      }
    })();
    res.json({ started:true, runId, monitorId: m.id });
  } catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

app.put('/synthetics/:id(\\d+)', async (req,res)=>{
  try {
    const id = Number(req.params.id);
    // Load from memory or DB
    let current = synthMonitors.find(m=>m.id===id);
    if(!current && db){
      try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ current = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(current); } } catch(_){ }
    }
    if(!current) return res.status(404).json({error:'not found'});
    let spec = normalizeSynthSpec(req.body?.spec||{}); ensureStepIds(spec);
    // Try to preserve IDs for structurally same steps by action+selector+url ordering
    const prevByKey = new Map();
  for(const s of (current.spec?.steps||[])) prevByKey.set(`${s.action}|${s.selector||''}|${s.url||''}`, s.id);
    for(const s of (spec.steps||[])) if(!s.id){
      const key = `${s.action}|${s.selector||''}|${s.url||''}`;
      if(prevByKey.has(key)) s.id = prevByKey.get(key);
    }
    ensureStepIds(spec);
    current.name = req.body.name ?? current.name;
    current.spec = spec;
    if (db){
      try { const { updateSynthMonitorSpec } = await import('./db.js'); updateSynthMonitorSpec(db, id, current.spec, current.spec.schedule); } catch(e){ console.warn('[synth] db update failed', e.message); }
    }
    res.json({ id, name: current.name, spec: current.spec });
  } catch(e){ console.error(e); res.status(500).json({error:'update failed', detail: String(e?.message||e)}); }
});

// Add a step (or steps) at end or at given index
app.post('/synthetics/:id(\\d+)/steps', async (req,res)=>{
  try {
    const id = Number(req.params.id);
  let current = synthMonitors.find(m=>m.id===id);
  if(!current && db){ try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ current = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(current); } } catch(_){ } }
  if(!current) return res.status(404).json({error:'not found'});
    const body = req.body || {};
    const stepsToAdd = Array.isArray(body.steps) ? body.steps : [body.step];
    if(!stepsToAdd || !stepsToAdd.length) return res.status(400).json({error:'no steps'});
    const index = typeof body.index==='number'? body.index : current.spec.steps.length;
    const newSteps = [...(current.spec.steps||[])];
    for(const raw of stepsToAdd){
      const step = normalizeSynthSpec({steps:[raw]}).steps[0];
      ensureStepIds({steps:[step]});
      newSteps.splice(Math.min(index, newSteps.length),0, step);
    }
    current.spec.steps = newSteps;
  if (db){ try { const { updateSynthMonitorSpec } = await import('./db.js'); updateSynthMonitorSpec(db, id, current.spec, current.spec.schedule); } catch(e){ console.warn('[synth] db add-step update failed', e.message); } }
    res.json({ id, steps: newSteps });
  } catch(e){ console.error(e); res.status(500).json({error:'add step failed'}); }
});

// Delete a single step by id
app.delete('/synthetics/:id(\\d+)/steps/:stepId', async (req,res)=>{
  try {
    const id = Number(req.params.id);
    const stepId = req.params.stepId;
  let current = synthMonitors.find(m=>m.id===id);
  if(!current && db){ try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ current = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(current); } } catch(_){ } }
  if(!current) return res.status(404).json({error:'not found'});
    const before = current.spec.steps?.length||0;
    current.spec.steps = (current.spec.steps||[]).filter(s=> s.id!==stepId);
    if((current.spec.steps||[]).length===before) return res.status(404).json({error:'step not found'});
  if (db){ try { const { updateSynthMonitorSpec } = await import('./db.js'); updateSynthMonitorSpec(db, id, current.spec, current.spec.schedule); } catch(e){ console.warn('[synth] db delete-step update failed', e.message); } }
    res.json({ id, removed: stepId, steps: current.spec.steps });
  } catch(e){ console.error(e); res.status(500).json({error:'delete step failed'}); }
});

// Replace entire steps array
app.put('/synthetics/:id(\\d+)/steps', async (req,res)=>{
  try {
    const id = Number(req.params.id);
  let current = synthMonitors.find(m=>m.id===id);
  if(!current && db){ try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ current = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(current); } } catch(_){ } }
  if(!current) return res.status(404).json({error:'not found'});
    let steps = Array.isArray(req.body?.steps) ? req.body.steps : [];
    steps = steps.map(s=> normalizeSynthSpec({steps:[s]}).steps[0]);
    const container = {steps}; ensureStepIds(container);
    current.spec.steps = container.steps;
  if (db){ try { const { updateSynthMonitorSpec } = await import('./db.js'); updateSynthMonitorSpec(db, id, current.spec, current.spec.schedule); } catch(e){ console.warn('[synth] db replace-steps update failed', e.message); } }
    res.json({ id, steps: current.spec.steps });
  } catch(e){ console.error(e); res.status(500).json({error:'replace steps failed'}); }
});

// Reorder steps by supplying an ordered array of step IDs
app.post('/synthetics/:id(\\d+)/steps/reorder', async (req,res)=>{
  try {
    const id = Number(req.params.id);
  let current = synthMonitors.find(m=>m.id===id);
  if(!current && db){ try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ current = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(current); } } catch(_){ } }
  if(!current) return res.status(404).json({error:'not found'});
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    if(!order.length) return res.status(400).json({error:'order_required'});
    const map = new Map((current.spec.steps||[]).map(s=>[s.id,s]));
    const newSteps = [];
    for(const sid of order){ if(map.has(sid)) newSteps.push(map.get(sid)); }
    // Append any missing steps (if some ids not included) at end to avoid accidental loss
    for(const s of current.spec.steps||[]){ if(!newSteps.includes(s)) newSteps.push(s); }
    current.spec.steps = newSteps;
  if (db){ try { const { updateSynthMonitorSpec } = await import('./db.js'); updateSynthMonitorSpec(db, id, current.spec, current.spec.schedule); } catch(e){ console.warn('[synth] db reorder-steps update failed', e.message); } }
    res.json({ id, steps: current.spec.steps });
  } catch(e){ console.error(e); res.status(500).json({error:'reorder failed'}); }
});

// Delete monitor
app.delete('/synthetics/:id(\\d+)', async (req,res)=>{
  noStore(res);
  try {
    const id = Number(req.params.id);
    const idx = synthMonitors.findIndex(m=>m.id===id);
    if (idx === -1 && !db) return res.status(404).json({ error:'not_found' });
    // Soft delete if DB; else hard delete
    if (db) {
      try { const { softDeleteSynthMonitor } = await import('./db.js'); softDeleteSynthMonitor(db, id); } catch(_){}
      const mem = synthMonitors.find(m=>m.id===id); if (mem) mem.deleted = true;
    } else {
      if (idx !== -1) synthMonitors.splice(idx,1);
      synthScheduleState.delete(id);
      for (let i=synthRuns.length-1;i>=0;i--) if (synthRuns[i].monitorId===id) synthRuns.splice(i,1);
    }
    res.json({ deleted:true, id, soft: !!db });
  } catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// Restore soft-deleted monitor
app.post('/synthetics/:id(\\d+)/restore', async (req,res)=>{
  noStore(res);
  try {
    const id = Number(req.params.id);
    if (!db) return res.status(400).json({ error:'not_supported' });
    const { restoreSynthMonitor, getSynthMonitor } = await import('./db.js');
    restoreSynthMonitor(db, id);
    let m = synthMonitors.find(x=>x.id===id);
    if(!m){ const row = getSynthMonitor(db, id); if(row){ m = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(m); } }
    if (!m) return res.status(404).json({ error:'not_found' });
    // Rebuild schedule state
    const sched = m.spec?.schedule || 'manual';
    const mins = SCHEDULE_MINUTES[sched] || 0;
    if (mins>0) synthScheduleState.set(m.id, { nextDueAt: Date.now() + mins*60000 });
    res.json({ restored:true, id });
  } catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// List runs (place BEFORE numeric id routes to avoid shadowing)
app.get('/synthetics/runs', async (req,res)=>{
  noStore(res);
  try{
    if (db){
      const { listSynthRuns } = await import('./db.js');
      const items = listSynthRuns(db, 50);
      if (items && items.length) return res.json({ items });
      return res.json({ items: synthRuns.slice(0,50) });
    }
  }catch(_){ }
  res.json({ items: synthRuns.slice(0,50) });
});

// Get a single run (detailed logs) - numeric id only
app.get('/synthetics/runs/:id(\\d+)', async (req,res)=>{
  noStore(res);
  try{
    const id = Number(req.params.id);
    let run = synthRuns.find(r=>r.id===id);
    if(!run && db){ try { const { getSynthRun } = await import('./db.js'); const row = getSynthRun(db, id); if(row){ run = row; } } catch(_){ } }
    if(!run) return res.status(404).json({ error:'not_found' });
    res.json(run);
  }catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// Get a single monitor (with spec) - numeric id only
app.get('/synthetics/:id(\\d+)', async (req,res)=>{
  noStore(res);
  try{
    const id = Number(req.params.id);
    let m = synthMonitors.find(x=>x.id===id);
    if(!m && db){
      try { const { getSynthMonitor } = await import('./db.js'); const row = getSynthMonitor(db, id); if(row){ m = { id: row.id, name: row.name, spec: row.spec, createdAt: row.createdAt }; synthMonitors.push(m); } } catch(_){ }
    }
    if(!m) return res.status(404).json({ error:'not_found' });
  try { ensureStepIds(m.spec); } catch(_){ }
  res.json({ id: m.id, name: m.name, spec: m.spec, createdAt: m.createdAt });
  }catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// (Removed earlier shadowed list runs route, now placed above)

async function runSyntheticMonitor(spec, runId){
  const logs = [];
  const stepsMeta = [];
  const logSynth = (m)=> { const entry = { ts: Date.now(), msg: m }; logs.push(entry); try { log.debug(`[synth:${runId}] ${m}`); } catch(_){} };
  await ensureSynthDir();
  const fileRel = `synth/run-${runId}.png`;
  const fileAbs = path.join(__dirname, '../public', fileRel);
  // Try Playwright first
  try {
    const pw = await import('playwright').catch(()=>null);
    if (pw && pw.chromium) {
      const browser = await pw.chromium.launch({ headless: true });
      // Extra headers from auth
      const extraHeaders = (spec?.auth?.headers && typeof spec.auth.headers === 'object') ? spec.auth.headers : undefined;
      const ctx = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        ...(extraHeaders? { extraHTTPHeaders: extraHeaders } : {})
      });
      // Cookies, if provided
      try{
        const startUrl = spec.startUrl || (spec.steps.find(s=>s.action==='goto')?.url) || '';
        const baseHost = startUrl ? new URL(startUrl).hostname : null;
        const cookies = Array.isArray(spec?.auth?.cookies) ? spec.auth.cookies : [];
        if (cookies.length){
          const toAdd = cookies.map(c=>({
            name: String(c.name),
            value: String(c.value),
            domain: String(c.domain || baseHost || ''),
            path: String(c.path || '/'),
            httpOnly: !!c.httpOnly,
            secure: !!c.secure,
            sameSite: c.sameSite || undefined
          })).filter(k=>k.name && k.value && k.domain);
          if (toAdd.length){ log(`auth: add ${toAdd.length} cookie(s)`); await ctx.addCookies(toAdd); }
        }
      }catch(_){ }
      const page = await ctx.newPage();
      const timeout = Number(spec.timeoutMs||30000);
      const startUrl = spec.startUrl || (spec.steps.find(s=>s.action==='goto')?.url) || '';
      let stepError = null;
      try {
        if(startUrl){
          const t0 = Date.now();
          log(`goto ${startUrl}`);
          try { await page.goto(startUrl, { timeout }); stepsMeta.push({ action:'goto', url:startUrl, ms: Date.now()-t0, ok:true }); }
          catch(e){ stepsMeta.push({ action:'goto', url:startUrl, ms: Date.now()-t0, ok:false, error:String(e?.message||e) }); throw e; }
        }
        let currentStep = null; let currentStart = 0; let recordedFail=false;
        for (const step of spec.steps){
          const t = step.timeoutMs || step.retryMs || timeout;
          const action = String(step.action||'').toLowerCase();
          currentStep = { action, selector: step.selector, url: step.url };
          currentStart = Date.now();
          try {
            if (action === 'goto' && step.url){ log(`goto ${step.url}`); await page.goto(step.url, { timeout: t }); }
            else if (action === 'click' && step.selector){ log(`click ${step.selector}`); await page.click(step.selector, { timeout: t }); }
            else if (action === 'type' && step.selector){ log(`type ${step.selector} ← ${step.text||''}`); await page.fill(step.selector, String(step.text||''), { timeout: t }); if(step.enter){ await page.keyboard.press('Enter'); } }
            else if (action === 'waitfor' && step.selector){ log(`waitFor ${step.selector}`); await page.waitForSelector(step.selector, { timeout: t }); }
            else if (action === 'wait' && step.ms){ const w=Math.min(step.ms, 120000); log(`wait ${w}ms`); await page.waitForTimeout(w); }
            else if (action === 'asserttextcontains'){
              const sel = step.selector || 'body';
              const txt = String(step.text||'').toLowerCase();
              const poll = step.pollMs || 600; // ms between retries
              const retryBudget = step.retryMs != null ? Number(step.retryMs) : (step.timeoutMs || 0);
              const deadline = retryBudget ? Date.now() + retryBudget : Date.now();
              let attempt = 0; let ok=false; let lastContent='';
              while(true){
                attempt++;
                try{
                  const content = await page.locator(sel).first().innerText({ timeout: Math.min(3000, t) }).catch(async()=> (await page.content()));
                  lastContent = String(content||'');
                  ok = txt ? lastContent.toLowerCase().includes(txt) : !!lastContent;
                }catch(err){ lastContent=''; ok=false; }
                if(ok) { log(`assertTextContains ${sel} ✓ after ${attempt} attempt(s)`); break; }
                if (retryBudget && Date.now() < deadline){ log(`assert retry ${sel} attempt=${attempt}`); await page.waitForTimeout(poll); continue; }
                break;
              }
              if(!ok){
                if(step.soft){ log(`soft assert failed ${sel} missing '${txt}'`); }
                else { throw new Error('assert_failed'); }
              }
            }
            stepsMeta.push({ ...currentStep, ms: Date.now()-currentStart, ok:true });
          } catch(innerErr){
            stepError = innerErr; recordedFail=true;
            log('step error: '+String(innerErr?.message||innerErr));
            stepsMeta.push({ ...currentStep, ms: Date.now()-currentStart, ok:false, error:String(innerErr?.message||innerErr) });
            break; // stop processing further steps
          }
        }
      } catch(err){
        if(!stepError) stepError = err; // already logged inside loop
      }
      // Always attempt screenshot even if a step failed
      try { await page.screenshot({ path: fileAbs, fullPage: true }); } catch(ssErr){ log('screenshot failed: '+String(ssErr?.message||ssErr)); }
      await browser.close();
      if (stepError){
        return { ok:false, statusText: String(stepError?.message||'failed'), screenshot: '/'+fileRel, logs, steps: stepsMeta };
      }
      return { ok: true, statusText: 'ok', screenshot: '/'+fileRel, logs, steps: stepsMeta };
    } else {
      log('playwright not available – using HTTP fallback (no screenshot)');
    }
  } catch(e){ log('playwright failed: '+String(e?.message||e)); }
  // Fallback: simple HTTP fetch
  try{
    const startUrl = spec.startUrl || (spec.steps.find(s=>String(s.action||'').toLowerCase()==='goto')?.url) || '';
    if (!startUrl) return { ok:false, statusText:'no_url', logs };
    log(`fetch ${startUrl}`);
    // Build headers from auth (including Cookie if cookies provided)
    const hdrs = (spec?.auth?.headers && typeof spec.auth.headers === 'object') ? { ...spec.auth.headers } : {};
    try{
      const cookies = Array.isArray(spec?.auth?.cookies) ? spec.auth.cookies : [];
      if (cookies.length){
        const cookieStr = cookies.map(c=>`${c.name}=${c.value}`).join('; ');
        if (cookieStr) hdrs['Cookie'] = cookieStr;
      }
    }catch(_){ }
    const r = await fetch(startUrl, Object.keys(hdrs).length? { headers: hdrs } : undefined);
    const statusNum = r.status;
    const text = await r.text();
    if (statusNum >= 400) {
      log(`http status ${statusNum}`);
      const snippet = text.slice(0,300).replace(/\s+/g,' ').trim();
      if (snippet) log(`body: ${snippet}`);
    }
    const assertStep = spec.steps.find(s=>String(s.action||'').toLowerCase()==='asserttextcontains');
    if (assertStep && assertStep.text) {
      const ok = text.toLowerCase().includes(String(assertStep.text).toLowerCase());
      return { ok, statusText: ok?'ok':'assert_failed', screenshot:null, logs };
    }
    return { ok: r.ok, statusText: String(statusNum), screenshot:null, logs, steps: stepsMeta };
  }catch(e){ log('fetch failed: '+String(e?.message||e)); return { ok:false, statusText:'fetch_failed', screenshot:null, logs, steps: stepsMeta }; }
}

// Simple scheduler loop for synthetic monitors
if (process.env.NODE_ENV !== 'test') {
  setInterval(async () => {
    try{
      const now = Date.now();
      let list = synthMonitors;
      if (db) {
        try {
          const { listSynthMonitors, getSynthMonitor } = await import('./db.js');
          const items = listSynthMonitors(db);
          const newList = [];
          for (const r of items) {
            if (r.deleted) continue; // skip soft deleted
            const full = getSynthMonitor(db, r.id);
            if (full && full.spec) newList.push({ id: full.id, name: full.name, createdAt: full.createdAt, spec: full.spec });
          }
          list = newList;
        } catch(_){ }
      }
      for (const m of list) {
        const mins = SCHEDULE_MINUTES[m.spec?.schedule || 'manual'] || 0;
        if (!mins) continue;
        const state = synthScheduleState.get(m.id) || { nextDueAt: now + mins*60000 };
        if (now >= state.nextDueAt && !synthRunning.has(m.id)) {
          // schedule next and run
          state.nextDueAt = now + mins*60000;
          synthScheduleState.set(m.id, state);
          synthRunning.add(m.id);
          const runId = synthRunNextId++;
          const startedAt = Date.now();
          console.log(`[scheduler] run monitor=${m.id} next=${new Date(state.nextDueAt).toISOString()}`);
          try{
            const result = await runSyntheticMonitor(m.spec, runId);
            const rec = { id: runId, monitorId: m.id, startedAt, finishedAt: Date.now(), ok: !!result.ok, statusText: result.statusText||'', screenshot: result.screenshot||null, logs: result.logs||[], steps: result.steps||[] };
            synthRuns.unshift(rec);
            if (db){ try { const { insertSynthRun } = await import('./db.js'); insertSynthRun(db, rec); } catch(_){ } }
          }catch(e){
            synthRuns.unshift({ id: runId, monitorId: m.id, startedAt, finishedAt: Date.now(), ok:false, statusText: 'scheduler_failed', screenshot:null, logs: [{ ts: Date.now(), msg: String(e?.message||e) }], steps: [] });
            if (db){ try { const { insertSynthRun } = await import('./db.js'); insertSynthRun(db, { id: runId, monitorId: m.id, startedAt, finishedAt: Date.now(), ok:false, statusText:'scheduler_failed', screenshot:null, logs: [{ ts: Date.now(), msg: String(e?.message||e) }], steps: [] }); } catch(_){ } }
          } finally {
            synthRunning.delete(m.id);
          }
        }
      }
    }catch(_){ }
  }, 30000);
}

// (no cache helper needed; DB spec is loaded in scheduler loop)

app.get('/logs/search', async (req,res)=>{
  noStore(res);
  if (!enableDb || !db) return res.status(400).json({ error:'ENABLE_DB=1 required' });
  console.log('[logs/search]', { q: String(req.query.query||'').slice(0,80), k: req.query.k, endpoint: req.query.endpoint||null });
  const { query = '', k = '20', from, to, endpoint, model, region } = req.query;
  const topK = Math.min(200, Number(k)||20);
  const filters = { from: from?Number(from):null, to: to?Number(to):null, endpoint: endpoint||null, model: model||null, region: region||null };
  // FTS
  const { searchLogsFts, iterLogsWithVecMeta, fetchLogsByIds } = await import('./db.js');
  const ftsHits = query ? searchLogsFts(db, String(query), 200) : [];
  // Vector
  let vecHits=[]; if (ENABLE_AI && process.env.OPENAI_API_KEY && query && query.trim()){
    try{
      const [qvec] = await embedTexts([String(query)], EMBEDDING_MODEL, process.env.OPENAI_API_KEY);
      const candidates = iterLogsWithVecMeta(db, { ...filters, limit: 2000 });
      vecHits = candidates.map(c=>({ id: c.id, score: cosine(qvec, c.emb) })).sort((a,b)=>b.score-a.score).slice(0,200);
    }catch(e){ console.warn('[logs/search] vec failed', e.message); }
  }
  // Fuse
  const ranks = new Map(); const addList=(arr,w)=>arr.forEach((h,i)=>ranks.set(h.id,(ranks.get(h.id)||0)+ w/(60+i)));
  if (vecHits.length) addList(vecHits,1.0); if (ftsHits.length) addList(ftsHits,0.8);
  let ids = Array.from(ranks.entries()).sort((a,b)=>b[1]-a[1]).map(([id])=>id);
  if (!ids.length) { const recent = db.prepare(`SELECT id FROM logs_raw ORDER BY ts DESC LIMIT ?`).all(topK); ids = recent.map(r=>r.id); }
  const rows = fetchLogsByIds(db, ids.slice(0, topK));
  const ftsMap = new Map(ftsHits.map(h=>[h.id,h.score])); const vecMap = new Map(vecHits.map(h=>[h.id,h.score]));
  const items = rows.map(r=>{ const sV=vecMap.get(r.id); const sF=ftsMap.get(r.id); let source=sV!=null && (sV>= (sF??-Infinity))?'vec':(sF!=null?'fts':'recent'); const score=source==='vec'?sV:(source==='fts'?(1/(1+(sF||1))):0); return { ...r, score, source }; }).sort((a,b)=> (b.score-a.score) || (b.ts-a.ts));
  res.json({ items });
});

// Simple logs listing for a time range and optional filters
app.get('/logs/list', async (req,res)=>{
  noStore(res);
  if (!enableDb || !db) return res.json({ items: [] });
  try{
    const { from, to, endpoint, model, region, limit='100' } = req.query;
    const top = Math.min(500, Number(limit)||100);
    let where = '1=1';
    const params = { limit: top };
    if (from) { where += ' AND ts >= @from'; params.from = Number(from); }
    if (to) { where += ' AND ts <= @to'; params.to = Number(to); }
    if (endpoint && endpoint !== '__all__') { where += ' AND endpoint = @endpoint'; params.endpoint = String(endpoint); }
    if (model) { where += ' AND model = @model'; params.model = String(model); }
    if (region) { where += ' AND region = @region'; params.region = String(region); }
    const sql = `SELECT id, ts, endpoint, model, region, level, status, latency_ms as latencyMs, tokens_prompt as tokensPrompt, tokens_completion as tokensCompletion, tokens_total as tokensTotal, err_type as errType, text FROM logs_raw WHERE ${where} ORDER BY ts DESC LIMIT @limit`;
    const rows = db.prepare(sql).all(params);
    res.json({ items: rows });
  }catch(e){ res.status(500).json({ error: String(e?.message||e) }); }
});

function cosine(a,b){ let dot=0,na=0,nb=0; const n=Math.min(a.length,b.length); for(let i=0;i<n;i++){const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y;} return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-8); }

// ===== AI metrics and summary (server-side helpers) =====
app.get('/ai/metrics', async (req, res) => {
  try {
    const windowMin = Number(req.query.window || '60');
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;
    const endpoint = req.query.endpoint || null;
    const stepSec = Math.max(10, Math.min(3600, Number(req.query.stepSec || '60')));
    const useAbsolute = from && to && to > from;
    const now = Date.now();
    const rangeFrom = useAbsolute ? from : (now - windowMin * 60000);
    const rangeTo = useAbsolute ? to : now;
    let rows = [];
    if (db && (fetchWindow || fetchRange)) {
      rows = useAbsolute ? fetchRange(db, { from: rangeFrom, to: rangeTo, endpoint }) : fetchWindow(db, { windowMinutes: windowMin, endpoint });
    } else {
      rows = store.points.filter(p => p.ts >= rangeFrom && p.ts <= rangeTo && (!endpoint || p.endpoint === endpoint));
    }
    const stepMs = stepSec * 1000;
    const bucketCount = Math.max(1, Math.ceil((rangeTo - rangeFrom) / stepMs));
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({ t: rangeFrom + i * stepMs, total: 0, ok: 0, _lat: [] }));
    for (const r of rows) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((r.ts - rangeFrom) / stepMs)));
      const b = buckets[idx];
      b.total++;
      if (r.ok) { b.ok++; if (typeof r.latencyMs === 'number') b._lat.push(r.latencyMs); }
    }
    function quantile(arr, q) {
      if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y);
      const pos = (a.length - 1) * q; const base = Math.floor(pos); const rest = pos - base;
      if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
      return a[base];
    }
    const out = buckets.map(b => ({ t: b.t, total: b.total, ok: b.ok, p50: quantile(b._lat, 0.5), p95: quantile(b._lat, 0.95), p99: quantile(b._lat, 0.99) }));
    res.json({ stepSec, from: new Date(rangeFrom).toISOString(), to: new Date(rangeTo).toISOString(), series: [{ key: { endpoint }, points: out }] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/ai/summary', async (req, res) => {
  try {
  console.log('[ai/summary]', { window: req.query.window, from: req.query.from, to: req.query.to, endpoint: req.query.endpoint||null });
    const windowMin = Number(req.query.window || '60');
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;
    const endpoint = req.query.endpoint || null;
    const useAbsolute = from && to && to > from;
    const now = Date.now();
    const rangeFrom = useAbsolute ? from : (now - windowMin * 60000);
    const rangeTo = useAbsolute ? to : now;
    let rows = [];
    if (db && (fetchWindow || fetchRange)) rows = useAbsolute ? fetchRange(db, { from: rangeFrom, to: rangeTo, endpoint }) : fetchWindow(db, { windowMinutes: windowMin, endpoint });
    else rows = store.points.filter(p => p.ts >= rangeFrom && p.ts <= rangeTo && (!endpoint || p.endpoint === endpoint));
    const ok = rows.filter(r => r.ok).length; const total = rows.length; const sli = total ? ok / total : 1;
    const lat = rows.filter(r => r.ok).map(r => r.latencyMs).sort((a,b)=>a-b);
    const q = (arr, p)=>{ if(!arr.length) return null; const idx=Math.floor((arr.length-1)*p); return arr[idx]; };
    const p50=q(lat,0.5), p95=q(lat,0.95), p99=q(lat,0.99);
    const byStatus = rows.reduce((acc,r)=>{ const k=String(r.status??(r.ok?200:0)); acc[k]=(acc[k]||0)+1; return acc; },{});
    const slow = rows.filter(r=>r.ok).sort((a,b)=>b.latencyMs-a.latencyMs).slice(0,5);
    res.json({ total, ok, sli, p50, p95, p99, errors: byStatus, slow });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Centralized helper for richer LLM prompts (sections + recommendations) ----
function buildLLMPromptComponents(opts) {
  const {
    wantPopularityModel, wantJoke, userMsg, historyBlock,
    from, to, endpoint, total, ok, sli, p50, p95, p99,
    topStatuses, logs, popularityFacts
  } = opts;
  // System prompt variants
  if (wantJoke) {
    return {
      sys: `Tell ONE short, clean, family-friendly programming joke. No preface, just the joke in one or two lines.`,
      ctx: `${historyBlock}User question: ${userMsg || '(none)'}\n`
    };
  }
  if (wantPopularityModel) {
    const sys = `You are an SRE / analytics assistant. Produce a concise (<180 words) structured answer about model usage and reliability.
Sections (omit if empty): Reliability, Models, Errors, Latency, Recommendations.
Rules:
- Do not invent metrics beyond those given.
- In Models: highlight top model share %, list next few compactly.
- Recommendations: 1-3 actionable bullets (e.g. investigate 429 spikes, optimize slow endpoints, reduce tail latency) referencing concrete data.
- Use plain text (no Markdown code fences) and keep each section label followed by a colon.
- Avoid repeating the exact same numbers in multiple sections unless essential.
- Never exceed ~180 words total.`;
    const ctx = `${historyBlock}`+
      `Window: ${new Date(from).toISOString()} to ${new Date(to).toISOString()}\n`+
      `Endpoint: ${endpoint||'all'}\n`+
      `Total: ${total}\nOK: ${ok}\nSLI: ${(sli*100).toFixed(2)}%\nLatency: p50=${p50??'–'}ms p95=${p95??'–'}ms p99=${p99??'–'}ms\nTop statuses: ${topStatuses||'—'}\n`+
      (popularityFacts? `${popularityFacts}\n` : '')+
      `Latest user question: ${userMsg || '(none)'}\n`+
      `Top logs:\n${logs.slice(0,5).map(l=>`[${new Date(l.ts).toISOString()}] ${l.status} ${l.endpoint} ${l.model||''} ${l.region||''} ${(l.text||'').slice(0,160)}`).join('\n')}`;
    return { sys, ctx };
  }
  // Default reliability-focused prompt
  const sys = `You are an SRE reliability assistant. Produce a concise (<180 words) structured narrative about the system's recent performance.
Sections (omit if empty): Reliability, Latency, Errors, Models, Recommendations.
Rules:
- Use each section label followed by a colon.
- Summarize SLI and major shifts; highlight tail latency if p95>500ms or p99>1000ms.
- In Errors: group by status codes; note if 429 or 5xx dominate.
- If model usage is varied, include Models with top 1-3 models and relative shares.
- Provide 1-3 bullet Recommendations each starting with a verb (Investigate, Optimize, Tune, Cache, Retry, Reduce, Add alert, etc.).
- Do NOT repeat identical numeric tuples across multiple sections; reference numbers once.
- Never fabricate data. If little data, say so.
- Keep total output under ~180 words, no markdown formatting beyond simple section labels and bullets (use '-' for bullets).`;
  const ctx = `${historyBlock}`+
    `Window: ${new Date(from).toISOString()} to ${new Date(to).toISOString()}\n`+
    `Endpoint: ${endpoint||'all'}\n`+
    `Total: ${total}\nOK: ${ok}\nSLI: ${(sli*100).toFixed(2)}%\nLatency: p50=${p50??'–'}ms p95=${p95??'–'}ms p99=${p99??'–'}ms\nTop statuses: ${topStatuses||'—'}\n`+
    `Latest user question: ${userMsg || '(none)'}\n`+
    `Top logs:\n${logs.slice(0,5).map(l=>`[${new Date(l.ts).toISOString()}] ${l.status} ${l.endpoint} ${l.model||''} ${l.region||''} ${(l.text||'').slice(0,160)}`).join('\n')}`;
  return { sys, ctx };
}

// ===== Chat endpoint (non-stream PoC) =====
app.post('/ai/chat', async (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userMsg = messages.length ? messages[messages.length - 1].content || '' : String(body.query || '');
    // Build a bounded multi-turn conversation history (exclude final user message)
    let historyBlock = '';
    if (messages.length > 1) {
      const prior = messages.slice(0, -1).filter(m=>m && typeof m.content === 'string');
      const recent = prior.slice(-12); // cap number of turns to avoid token bloat
      const formatted = recent.map((m,i)=>{
        const role = (m.role||'user').toLowerCase();
        if (role === 'system') return null; // skip system for now
        const tag = role === 'assistant' ? 'assistant' : 'user';
        let content = m.content.trim();
        if (content.length > 500) content = content.slice(0,500)+"…"; // truncate long entries
        return `${i+1}. ${tag}: ${content}`;
      }).filter(Boolean);
      if (formatted.length) {
        historyBlock = `Conversation so far (most recent last):\n${formatted.join('\n')}\n---\n`;
      }
    }
    const endpoint = body.filters?.endpoint || null;
    const modelF = body.filters?.model || null;
    const regionF = body.filters?.region || null;
    const now = Date.now();
    const from = body.from ? Number(body.from) : (now - 60*60000);
    const to = body.to ? Number(body.to) : now;
  if (should('debug')) log.debug('[ai/chat]', { llm: !!body.llm, endpoint, from, to, promptLen: (userMsg||'').length });

    // Metrics summary
    const mReq = { query: { from: String(from), to: String(to), endpoint: endpoint || '' } };
    // Reuse handler logic directly by calling functions
    const useAbs = true;
    let rows = [];
    if (db && (fetchWindow || fetchRange)) rows = fetchRange(db, { from, to, endpoint: endpoint || undefined });
    else rows = store.points.filter(p=>p.ts>=from && p.ts<=to && (!endpoint || p.endpoint===endpoint));
    const ok = rows.filter(r=>r.ok).length; const total = rows.length; const sli = total? ok/total : 1;
    const lat = rows.filter(r=>r.ok).map(r=>r.latencyMs).sort((a,b)=>a-b);
    const q=(arr,p)=>{ if(!arr.length) return null; const idx=Math.floor((arr.length-1)*p); return arr[idx]; };
    const p50=q(lat,0.5), p95=q(lat,0.95), p99=q(lat,0.99);
    const byStatus = rows.reduce((acc,r)=>{ const k=String(r.status??(r.ok?200:0)); acc[k]=(acc[k]||0)+1; return acc; },{});

  // --- Intent detection (direct metric Q&A + chart) ---
  // Slowest endpoint intent: user explicitly asks which endpoint is the slowest (latency focused question)
  const lowerQ = String(userMsg||'').toLowerCase();
  // Broaden chart intent detection (allow common misspellings and concatenations like piechart, piechat)
  const chartIntent = /(pie\s*chart|piechart|piechat|pie|bar|chart|graph|visual|visualize|plot)/.test(lowerQ);
  const observationIntent = /(observation|observations|insight|insights|what\s+do\s+you\s+see|what's\s+your\s+take|pattern|trends?)/.test(lowerQ);
  let chartSpec = null; // will attach to response if built
    const slowestIntent = /(which|what)?\s*(is\s*)?(the\s*)?slow(est)?\s+endpoint/.test(lowerQ) || /slowest\s+endpoint/.test(lowerQ);
    let directAnswer = null; let directIntent = null;
    if (slowestIntent) {
      // Group latencies by endpoint (successful calls only)
      const groups = new Map();
      for (const r of rows) {
        if (!r.ok || typeof r.latencyMs !== 'number') continue;
        const ep = r.endpoint || '(unknown)';
        const arr = groups.get(ep) || []; arr.push(r.latencyMs); groups.set(ep, arr);
      }
      if (!groups.size) {
        directAnswer = 'No successful requests in range.';
      } else {
        const quant = (arr,q)=>{ if(!arr.length) return 0; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const b=Math.floor(pos); const rest=pos-b; return a[b+1]!==undefined ? a[b]+rest*(a[b+1]-a[b]) : a[b]; };
        const stats = Array.from(groups.entries()).map(([ep,arr])=>({ ep, count: arr.length, p95: Math.round(quant(arr,0.95)||0), p99: Math.round(quant(arr,0.99)||0), p50: Math.round(quant(arr,0.50)||0) }));
        // Require at least 2 samples to avoid single outlier noise
        const eligible = stats.filter(s=>s.count>=2);
        const ranking = (eligible.length?eligible:stats).sort((a,b)=> b.p95 - a.p95 || b.p99 - a.p99 || b.p50 - a.p50);
        const top = ranking[0];
        const second = ranking[1];
        if (top) {
          directAnswer = `Slowest endpoint (by p95) is ${top.ep} (p95 ${top.p95} ms, p99 ${top.p99} ms, samples ${top.count}).` + (second?` Next: ${second.ep} (p95 ${second.p95} ms).`: '');
        } else {
          directAnswer = 'Unable to determine slowest endpoint.';
        }
      }
      directIntent = 'slowest_endpoint';
    }

    // Logs: hybrid search (FTS + vectors when available)
    let logs = [];
    try {
      const { searchLogsFts, iterLogsWithVecMeta, fetchLogsByIds } = await import('./db.js');
      const ftsHits = userMsg ? searchLogsFts(db, String(userMsg), 200) : [];
      let vecHits = [];
      if (ENABLE_AI && process.env.OPENAI_API_KEY && userMsg && userMsg.trim()) {
        try {
          const [qvec] = await embedTexts([String(userMsg)], EMBEDDING_MODEL, process.env.OPENAI_API_KEY);
          const candidates = iterLogsWithVecMeta(db, { from, to, endpoint: endpoint || null, limit: 2000 });
          vecHits = candidates.map(c=>({ id: c.id, score: cosine(qvec, c.emb) })).sort((a,b)=>b.score-a.score).slice(0,200);
        } catch(e) { console.warn('[ai/chat] vec failed', e.message); }
      }
      const ranks = new Map(); const add=(arr,w)=>arr.forEach((h,i)=>ranks.set(h.id,(ranks.get(h.id)||0)+ w/(60+i)));
      if (vecHits.length) add(vecHits,1.0); if (ftsHits.length) add(ftsHits,0.8);
      let ids = Array.from(ranks.entries()).sort((a,b)=>b[1]-a[1]).map(([id])=>id).slice(0,20);
      if (!ids.length) {
        ids = ftsHits.slice(0, 20).map(h=>h.id);
      }
      logs = fetchLogsByIds(db, ids);
    } catch {}

    // Fallback: when DB disabled or no log rows found, synthesize pseudo-log entries from probe points
    if (!logs.length) {
      const probeLike = rows.slice(0, 20).map(r => ({
        id: r.ts, // unique-ish per point
        ts: r.ts,
        endpoint: r.endpoint,
        model: r.model,
        region: r.region,
        status: r.status || (r.ok ? 200 : null),
        text: `${r.status|| (r.ok?200:'?')} ${r.endpoint} latency=${r.latencyMs}ms model=${r.model||''} region=${r.region||''}`.trim()
      }));
      logs = probeLike;
    }

  // Intent detection
  const wantPopularityModel = /(most\s+(popular|used|common)|top\s+model|popular|populate)/.test(lowerQ);
  const wantJoke = /(\btell\b.*\bjoke\b|\bjoke\b|\bfunny\b|\blaugh\b)/.test(lowerQ);

  // Compose an answer (LLM-free, but contextual)
    const topStatuses = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ');
    const rangeStr = `${new Date(from).toISOString()} → ${new Date(to).toISOString()}`;
    const epStr = endpoint ? ` for ${endpoint}` : '';
    const baseLine = `In ${rangeStr}${epStr}, total=${total}, ok=${ok} (SLI ${(sli*100).toFixed(2)}%). Latency p50=${p50??'–'}ms p95=${p95??'–'}ms p99=${p99??'–'}ms. Top statuses: ${topStatuses||'—'}.`;
    const want429 = /429|rate.?limit/.test(lowerQ);
    const wantError = /error|fail|5\d\d|4\d\d/.test(lowerQ);
    const wantLatency = /latency|slow|p95|p99|perf/.test(lowerQ);
    const wantCost = /cost|token/.test(lowerQ);
    const details = [];
    if (want429) {
      const c429 = rows.filter(r => (r.status||0)===429).length;
      details.push(`429s: ${c429}`);
    }
    if (wantError) {
      const errTop = Object.entries(byStatus).filter(([k])=>Number(k)>=400).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ');
      if (errTop) details.push(`Top error statuses: ${errTop}`);
    }
    if (wantLatency) {
      const worst = rows.filter(r=>r.ok).sort((a,b)=>b.latencyMs-a.latencyMs).slice(0,3).map(r=>`${r.latencyMs}ms ${r.endpoint} ${r.model||''} ${r.region||''}`).join(' | ');
      if (worst) details.push(`Slowest ok: ${worst}`);
    }
    if (wantCost) {
      const tokTotal = rows.reduce((a,r)=>a+(r.tokensTotal||0),0);
      const tokPrompt = rows.reduce((a,r)=>a+(r.tokensPrompt||0),0);
      const tokComp = rows.reduce((a,r)=>a+(r.tokensCompletion||0),0);
      details.push(`Tokens total=${tokTotal} (prompt=${tokPrompt}, completion=${tokComp})`);
    }
    // Include brief log snippets when available
    const logSnippet = logs.length ? `Top log: ${String(logs[0].text||'').slice(0,140)}` : '';
    // Popular model analysis when asked
    let popularityBlock = '';
    if (wantPopularityModel) {
      let topModels = [];
      try {
        if (db) {
          const params = { from, to };
          let sql = `SELECT model AS key, COUNT(1) AS c FROM logs_raw WHERE ts BETWEEN @from AND @to AND model IS NOT NULL AND model <> ''`;
          if (endpoint) { sql += ` AND endpoint = @endpoint`; params.endpoint = endpoint; }
          sql += ` GROUP BY model ORDER BY c DESC LIMIT 5`;
          const rowsM = db.prepare(sql).all(params);
          topModels = rowsM.map(r=>({ key: r.key, count: r.c }));
        }
      } catch {}
      if (!topModels.length) {
        // fallback to probe rows
        const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k]=(acc[k]||0)+1; return acc; },{});
        topModels = Object.entries(counts).map(([k,v])=>({ key:k, count:v })).sort((a,b)=>b.count-a.count).slice(0,5);
      }
      const grand = topModels.reduce((a,x)=>a+x.count,0) || total || 1;
      if (topModels.length) {
        const lead = topModels[0];
        const share = ((lead.count/(grand||1))*100).toFixed(1);
        const rest = topModels.slice(1).map(m=>`${m.key}: ${m.count} (${((m.count/(grand||1))*100).toFixed(1)}%)`).join(', ');
        popularityBlock = `Most used model${epStr}: ${lead.key} — ${lead.count} calls (${share}%) in ${rangeStr}.` + (rest?` Next: ${rest}.`: '');
      } else {
        popularityBlock = `No model usage found in ${rangeStr}${epStr}.`;
      }
    }

    // Build contextual data tables for diagram
    const dataTables = [];
    let dataContext = null;
    if (wantPopularityModel) {
      let topModels = [];
      try {
        if (db) {
          const params = { from, to };
          let sql = `SELECT model AS key, COUNT(1) AS c FROM logs_raw WHERE ts BETWEEN @from AND @to AND model IS NOT NULL AND model <> ''`;
          if (endpoint) { sql += ` AND endpoint = @endpoint`; params.endpoint = endpoint; }
          sql += ` GROUP BY model ORDER BY c DESC LIMIT 5`;
          const rowsM = db.prepare(sql).all(params);
          topModels = rowsM.map(r=>({ key: r.key, count: r.c }));
        }
      } catch {}
      if (!topModels.length) {
        const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k]=(acc[k]||0)+1; return acc; },{});
        topModels = Object.entries(counts).map(([k,v])=>({ key:k, count:v })).sort((a,b)=>b.count-a.count).slice(0,5);
      }
      const tbl = { name:'popular_models', rows: topModels.map(m=>[m.key, m.count]) };
      dataTables.push(tbl);
      dataContext = { table: 'popular_models', title: 'Most used models' };
    } else if (wantLatency) {
      // Aggregate p95 latency by endpoint (ok requests only)
      const groups = new Map();
      for (const r of rows) {
        if (!r.ok || typeof r.latencyMs !== 'number') continue;
        const key = r.endpoint || '(unknown)';
        const arr = groups.get(key) || [];
        arr.push(r.latencyMs);
        groups.set(key, arr);
      }
      const quant = (arr,q)=>{ if(!arr.length) return 0; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const b=Math.floor(pos); const rest=pos-b; return a[b+1]!==undefined ? a[b]+rest*(a[b+1]-a[b]) : a[b]; };
      const items = Array.from(groups.entries()).map(([k,arr])=>[k, Math.round(quant(arr,0.95))]).sort((a,b)=>b[1]-a[1]).slice(0,7);
      if (items.length) {
        dataTables.push({ name:'latency_by_endpoint', rows: items });
        dataContext = { table: 'latency_by_endpoint', title: 'Endpoint p95 latency' };
      }
    } else if (wantError || want429) {
      dataContext = { table: 'errors_by_status', title: 'Errors by status' };
    } else if (wantCost) {
      dataContext = { table: 'tokens_summary', title: 'Tokens' };
    }

    let answer;
    if (directIntent === 'slowest_endpoint' && directAnswer) {
      // Short-circuit summary style for direct intent
      answer = directAnswer;
    } else {
      answer = wantPopularityModel
        ? [popularityBlock, details.join(' • '), logSnippet].filter(Boolean).join('\n')
        : [baseLine, details.join(' • '), logSnippet].filter(Boolean).join('\n');
    }
    // Build chartSpec if user appeared to ask for a chart or visualization
    if (!chartSpec && chartIntent) {
      const wantErrorsChart = /error|errors|fail|fails|failure|5\d\d|4\d\d/.test(lowerQ);
      const wantLatencyChart = /latency|slow|p95|p99|perf|performance/.test(lowerQ) || /endpoint/.test(lowerQ);
      const wantLatencyPie = wantLatencyChart && /(pie|piechart|piechat)/.test(lowerQ);
      if (wantErrorsChart) {
        const entries = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,8);
        chartSpec = entries.length
          ? { type: 'pie', title: 'Errors by Status', series: [{ name: 'status', labels: entries.map(e=>e[0]), values: entries.map(e=>e[1]) }], meta: { source: 'errors_by_status' } }
          : { type: 'pie', title: 'Errors by Status', series: [{ name: 'status', labels: [], values: [] }], meta: { source: 'errors_by_status', empty: true } };
      } else if (wantLatencyPie) {
        // Build latency distribution buckets for pie chart
        const buckets = [
          { label: '<100ms', test: v=>v<100 },
          { label: '100-300ms', test: v=>v>=100 && v<300 },
          { label: '300-700ms', test: v=>v>=300 && v<700 },
          { label: '700-1500ms', test: v=>v>=700 && v<1500 },
          { label: '>=1500ms', test: v=>v>=1500 }
        ];
        const okLat = rows.filter(r=>r.ok && typeof r.latencyMs==='number').map(r=>r.latencyMs);
        const values = buckets.map(b=> okLat.filter(v=>b.test(v)).length );
        chartSpec = { type: 'pie', title: 'Latency Distribution', series: [{ name: 'latency_bucket', labels: buckets.map(b=>b.label), values }], meta: { source: 'latency_buckets' } };
      } else if (wantLatencyChart) {
        const groups = new Map();
        for (const r of rows) { if (!r.ok || typeof r.latencyMs !== 'number') continue; const ep = r.endpoint||'(unknown)'; const arr = groups.get(ep)||[]; arr.push(r.latencyMs); groups.set(ep, arr); }
        const quant = (arr,q)=>{ if(!arr.length) return 0; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const b=Math.floor(pos); const rest=pos-b; return a[b+1]!==undefined ? a[b]+rest*(a[b+1]-a[b]) : a[b]; };
        const stats = Array.from(groups.entries()).map(([ep,arr])=>({ ep, p95: Math.round(quant(arr,0.95)||0) })).sort((a,b)=>b.p95-a.p95).slice(0,8);
        chartSpec = stats.length
          ? { type: 'bar', title: 'Endpoint p95 latency (ms)', x: stats.map(s=>s.ep), y: stats.map(s=>s.p95), meta: { source: 'latency_by_endpoint', metric: 'p95_latency_ms' } }
          : { type: 'bar', title: 'Endpoint p95 latency (ms)', x: [], y: [], meta: { source: 'latency_by_endpoint', metric: 'p95_latency_ms', empty: true } };
      }
    }
    // Build a friendly non-LLM narrative
    function buildNarrative(){
      const sliPct = (sli*100).toFixed(2);
      const health = sli>=0.995? 'Excellent reliability' : sli>=0.985? 'Good but slightly degraded' : sli>=0.95? 'Noticeably degraded' : 'Significantly degraded';
      const errSorted = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]);
      const errTopEntry = errSorted[0];
      const errSecond = errSorted[1];
      let errMsg = '';
      if (errTopEntry){
        const [code, cnt] = errTopEntry; const rate = total? ((cnt/total)*100).toFixed(1) : '0.0';
        if (String(code)==='429') errMsg = `Rate limiting spikes (429) comprise ${rate}% of requests—throttle or retry tuning may be needed.`;
        else if (/^5\d\d$/.test(String(code))) errMsg = `Server error ${code} leads with ${rate}% share—investigate backend regressions.`;
        else if (Number(code)>=400) errMsg = `Client error ${code} dominates (${rate}%), suggesting validation or request-shape issues.`;
      }
      let errFollow='';
      if (errSecond){
        const [code2, cnt2] = errSecond; const rate2 = total? ((cnt2/total)*100).toFixed(1):'0.0';
        errFollow = ` Next error: ${code2} (${rate2}%).`;
      }
      const latMsg = (p95!=null && p99!=null)
        ? `Latency tail: p95 ${p95} ms / p99 ${p99} ms (p50 ${p50??'–'} ms).`
        : '';
      // Highlight slowest endpoints (top 2) if latency focus
      let slowDesc='';
      if (wantLatency) {
        const slowest = rows.filter(r=>r.ok).sort((a,b)=>b.latencyMs-a.latencyMs).slice(0,2).map(r=>`${r.endpoint} ${r.latencyMs}ms`).join(', ');
        if (slowest) slowDesc = `Slowest recent calls: ${slowest}.`;
      }
      let popularityDesc='';
      if (wantPopularityModel && popularityBlock) popularityDesc = popularityBlock;
      // Observation style bullet list when explicitly asked for observations / insights
      if (observationIntent) {
        const bullets = [];
        bullets.push(`Reliability: ${health} (SLI ${sliPct}%).`);
        if (latMsg) bullets.push(latMsg);
        if (errMsg) bullets.push(errMsg + errFollow);
        if (slowDesc) bullets.push(slowDesc);
        if (popularityDesc) bullets.push(popularityDesc);
        if (!bullets.length) bullets.push('No significant signals detected in the selected range.');
        return bullets.map(b=>'• '+b).join('\n');
      }
      const parts = [ `${health} (SLI ${sliPct}%).`, latMsg, errMsg+errFollow, slowDesc, popularityDesc ].filter(Boolean);
      return parts.join(' ');
    }
    // Off-topic lightweight handling (no LLM): return a short, clean joke when explicitly asked
    if (!body.llm && wantJoke) {
      answer = "Why do programmers prefer dark mode? Because light attracts bugs.";
    }
    // If user requested LLM but the question is a direct deterministic metric intent, skip LLM to preserve concise answer
    if (directIntent && body.llm) {
      body.llm = false; // override to avoid verbose summarization
    }

  // Optional LLM enhancement when requested and configured
  let usedLLM = false;
  const useLLM = body.llm === true && !!process.env.OPENAI_API_KEY;
  let llmModel = null; let llmTried = false; let llmStatus = null;
  // Ensure route/fallback vars exist even when LLM path not executed
  let llmRoute = null; let llmFallback = null;
  if (useLLM) {
      try {
        llmTried = true;
        // Aggregate popularity facts if needed for central builder
        let popularityFacts='';
        if (wantPopularityModel) {
          try {
            let facts = [];
            if (db) {
              const params = { from, to };
              let sql = `SELECT model AS key, COUNT(1) AS c FROM logs_raw WHERE ts BETWEEN @from AND @to AND model IS NOT NULL AND model <> ''`;
              if (endpoint) { sql += ` AND endpoint = @endpoint`; params.endpoint = endpoint; }
              sql += ` GROUP BY model ORDER BY c DESC LIMIT 10`;
              const rowsM = db.prepare(sql).all(params);
              facts = rowsM.map(r=>`${r.key}: ${r.c}`).join(', ');
            }
            if (!facts) {
              const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k] = (acc[k]||0)+1; return acc; },{});
              const ordered = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`${k}: ${v}`).join(', ');
              facts = ordered;
            }
            popularityFacts = `Model usage (count): ${facts}`;
          } catch {}
        }
        const { sys, ctx } = buildLLMPromptComponents({
          wantPopularityModel, wantJoke, userMsg, historyBlock,
          from, to, endpoint, total, ok, sli, p50, p95, p99,
          topStatuses, logs, popularityFacts
        });
  // Allow per-request override (body.model) if provided and in allowlist; else env; else default
  const MODEL_ALLOWLIST = new Set([
    'gpt-4.1-mini','gpt-4.1','gpt-4o-mini','gpt-4o','gpt-4o-realtime-preview',
    'o4-mini','o4','gpt-4.1-nano','gpt-4o-mini-translate','chatgpt-4o-latest',
    'gpt-5','gpt-5-mini','gpt-5-nano',
    'text-embedding-3-small','text-embedding-3-large','omni-moderation-latest'
  ]);
  const reqModelRaw = (typeof body.model === 'string') ? body.model.trim() : '';
  let overrideModel = null;
  if (reqModelRaw && MODEL_ALLOWLIST.has(reqModelRaw)) overrideModel = reqModelRaw;
  llmModel = overrideModel || process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  // reuse outer llmRoute/llmFallback
  async function callResponses(modelName){
    const isG5 = /^gpt-5/.test(modelName);
    // For gpt-5* send a minimal payload (model + input) to avoid unsupported params while schema stabilizes
    let payload;
    if (isG5) {
      payload = { model: modelName, input:[ { role:'system', content:[{ type:'input_text', text: sys }] }, { role:'user', content:[{ type:'input_text', text: ctx }] } ] };
    } else {
  payload = { model: modelName, input:[ { role:'system', content:[{ type:'input_text', text: sys }] }, { role:'user', content:[{ type:'input_text', text: ctx }] } ], max_output_tokens: 450, temperature: 0.2 };
    }
    return fetch('https://api.openai.com/v1/responses', { method:'POST', headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(payload) });
  }
  async function callChat(modelName){
    const isG5 = /^gpt-5/.test(modelName);
    let payload;
    if (isG5) {
      payload = { model: modelName, messages:[ { role:'system', content: sys }, { role:'user', content: ctx } ] }; // minimal payload
    } else {
  payload = { model: modelName, messages:[ { role:'system', content: sys }, { role:'user', content: ctx } ], max_tokens: 450, temperature: 0.2 };
    }
    return fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(payload) });
  }
  // Prefer chat/completions for gpt-5* models (assumed not yet on responses)
  const preferChat = /^gpt-5/.test(llmModel);
  try {
    let primaryResp; let primaryModel = llmModel; let primaryRoute;
    if (preferChat) { primaryRoute='chat.completions'; primaryResp = await callChat(primaryModel); }
    else { primaryRoute='responses'; primaryResp = await callResponses(primaryModel); }
    llmStatus = primaryResp.status; llmRoute = primaryRoute;
    if (primaryResp.ok) {
      const j = await primaryResp.json();
      const txt = primaryRoute==='responses'? extractResponsesText(j): extractChatCompletionsText(j);
      if (txt) { answer = txt; usedLLM = true; }
    } else {
      // Attempt alternate route if 4xx and other route not tried yet
      if (primaryResp.status>=400 && primaryResp.status<500) {
        const altRoute = primaryRoute==='responses' ? 'chat.completions' : 'responses';
        let primaryErrSnippet = null; try { primaryErrSnippet = (await primaryResp.text()).slice(0,300); } catch(_){ }
        llmFallback = { reason:'primary_failed', primaryRoute, primaryStatus: primaryResp.status, primaryErr: primaryErrSnippet };
        try {
          const altResp = primaryRoute==='responses'? await callChat(primaryModel) : await callResponses(primaryModel);
          llmStatus = altResp.status; llmRoute = altRoute;
          if (altResp.ok) {
            const j2 = await altResp.json();
            const txt2 = altRoute==='responses'? extractResponsesText(j2): extractChatCompletionsText(j2);
            if (txt2) { answer = txt2; usedLLM = true; }
            llmFallback.altSucceeded = true;
          } else {
            let altErrSnippet=null; try { altErrSnippet=(await altResp.text()).slice(0,300); } catch(_){ }
            llmFallback.altStatus = altResp.status; if(altErrSnippet) llmFallback.altErr = altErrSnippet;
          }
        } catch(eAlt){ llmFallback.altError = String(eAlt?.message||eAlt); }
      }
      // Final fallback to default model via responses if still not used
      if (!usedLLM && llmModel !== 'gpt-4o-mini') {
        try {
          const fbModel = 'gpt-4o-mini';
          const fbResp = await callResponses(fbModel);
          llmStatus = fbResp.status; llmRoute = 'responses';
          llmFallback = { ...(llmFallback||{}), finalFallbackModel: fbModel, finalFallbackRoute:'responses', finalFallbackStatus: fbResp.status };
          if (fbResp.ok) { const jf = await fbResp.json(); const txtf = extractResponsesText(jf); if (txtf) { answer = txtf; usedLLM = true; llmModel = fbModel; } }
        } catch(eFb){ llmFallback = { ...(llmFallback||{}), finalFallbackError: String(eFb?.message||eFb) }; }
      }
    }
  if (should('info')) log.info('[ai/chat] LLM', { tried: llmTried, used: usedLLM, status: llmStatus, model: llmModel, route: llmRoute, fallback: llmFallback||null });
  } catch(eAll) {
    llmFallback = { ...(llmFallback||{}), outerError: String(eAll?.message||eAll) };
    console.warn('[ai/chat] LLM failed', String(eAll?.message||eAll));
  }
  // Attach debug metadata to response later (answer variable already set)
      } catch(e) {
        // fall back silently
    console.warn('[ai/chat] LLM failed', String(e?.message||e));
      }
    }

    // Build evidence objects for grounding (up to 10 best logs)
    const evidence = logs.slice(0,10).map(l=>({
      id: l.id,
      ts: l.ts,
      endpoint: l.endpoint || null,
      model: l.model || null,
      region: l.region || null,
      status: l.status || null,
      text: (l.text||'').slice(0,400)
    }));
    const citations = { logs: logs.map(l=>l.id), metrics: ['summary'] };
    const tokensTotal = rows.reduce((a,r)=>a+(r.tokensTotal||0),0);
    const tokensPrompt = rows.reduce((a,r)=>a+(r.tokensPrompt||0),0);
    const tokensCompletion = rows.reduce((a,r)=>a+(r.tokensCompletion||0),0);
    const topErrs = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const summary = {
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      endpoint: endpoint || 'all',
      totals: { total, ok, sli },
      latency: { p50: p50||0, p95: p95||0, p99: p99||0 },
      errors: topErrs,
      tokens: { prompt: tokensPrompt, completion: tokensCompletion, total: tokensTotal }
    };
  const data = { tables: [
      { name:'errors_by_status', rows: Object.entries(byStatus) },
      { name:'lat_percentiles', rows: [['p50', p50||0], ['p95', p95||0], ['p99', p99||0]] },
      { name:'tokens_summary', rows: [['prompt', tokensPrompt], ['completion', tokensCompletion], ['total', tokensTotal]] }
  ].concat(dataTables), context: dataContext };
  const narrative = (usedLLM && answer) ? answer : (directIntent==='slowest_endpoint' ? directAnswer : buildNarrative());
  // Expose debug routing metadata to help diagnose 400s on certain model families
  try {
    const dbgErrors = /error|errors|fail|fails|failure|5\d\d|4\d\d/.test(lowerQ);
    const dbgLatency = /latency|slow|p95|p99|perf|performance/.test(lowerQ) || /endpoint/.test(lowerQ);
  if (should('debug')) log.debug('[ai/chat][debug]', { lowerQ, chartIntent, dbgErrors, dbgLatency, hasChartSpec: !!chartSpec, chartType: chartSpec && chartSpec.type });
  } catch(_) { /* ignore */ }
  res.json({ answer, narrative, citations, evidence, data, summary, usedLLM, llmModel, llmTried, llmStatus, llmRoute, llmFallback, chartSpec });
  // Clients not using these fields can ignore; shape additive (non-breaking)
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Streaming version: emits NDJSON lines with {delta} tokens and a final {done,citations}
app.post('/ai/chat/stream', async (req, res) => {
  try {
    res.set('Content-Type', 'application/x-ndjson');
    res.set('Cache-Control', 'no-store');
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userMsg = messages.length ? messages[messages.length - 1].content || '' : String(body.query || '');
    // Build bounded multi-turn history (exclude final user message)
    let historyBlock = '';
    if (messages.length > 1) {
      const prior = messages.slice(0,-1).filter(m=>m && typeof m.content === 'string');
      const recent = prior.slice(-12);
      const formatted = recent.map((m,i)=>{
        const role = (m.role||'user').toLowerCase();
        if (role === 'system') return null;
        const tag = role === 'assistant' ? 'assistant' : 'user';
        let content = m.content.trim();
        if (content.length > 500) content = content.slice(0,500)+"…";
        return `${i+1}. ${tag}: ${content}`;
      }).filter(Boolean);
      if (formatted.length) historyBlock = `Conversation so far (most recent last):\n${formatted.join('\n')}\n---\n`;
    }
    const endpoint = body.filters?.endpoint || null;
    const now = Date.now();
    const from = body.from ? Number(body.from) : (now - 60*60000);
    const to = body.to ? Number(body.to) : now;
  if (should('debug')) log.debug('[ai/chat/stream]', { llm: !!body.llm, endpoint, from, to, promptLen: (userMsg||'').length });

    // Collect metrics (same as non-stream)
    let rows = [];
    if (db && (fetchWindow || fetchRange)) rows = fetchRange(db, { from, to, endpoint: endpoint || undefined });
    else rows = store.points.filter(p=>p.ts>=from && p.ts<=to && (!endpoint || p.endpoint===endpoint));
    const ok = rows.filter(r=>r.ok).length; const total = rows.length; const sli = total? ok/total : 1;
    const lat = rows.filter(r=>r.ok).map(r=>r.latencyMs).sort((a,b)=>a-b);
    const q=(arr,p)=>{ if(!arr.length) return null; const idx=Math.floor((arr.length-1)*p); return arr[idx]; };
    const p50=q(lat,0.5), p95=q(lat,0.95), p99=q(lat,0.99);
    const byStatus = rows.reduce((acc,r)=>{ const k=String(r.status??(r.ok?200:0)); acc[k]=(acc[k]||0)+1; return acc; },{});

    // Logs: hybrid (FTS + vector if available)
    let logs = [];
    try {
      const { searchLogsFts, iterLogsWithVecMeta, fetchLogsByIds } = await import('./db.js');
      const ftsHits = userMsg ? searchLogsFts(db, String(userMsg), 200) : [];
      let vecHits = [];
      if (ENABLE_AI && process.env.OPENAI_API_KEY && userMsg && userMsg.trim()) {
        try {
          const [qvec] = await embedTexts([String(userMsg)], EMBEDDING_MODEL, process.env.OPENAI_API_KEY);
          const candidates = iterLogsWithVecMeta(db, { from, to, endpoint: endpoint || null, limit: 2000 });
          vecHits = candidates.map(c=>({ id: c.id, score: cosine(qvec, c.emb) })).sort((a,b)=>b.score-a.score).slice(0,200);
        } catch(e) {}
      }
      const ranks = new Map(); const add=(arr,w)=>arr.forEach((h,i)=>ranks.set(h.id,(ranks.get(h.id)||0)+ w/(60+i)));
      if (vecHits.length) add(vecHits,1.0); if (ftsHits.length) add(ftsHits,0.8);
      let ids = Array.from(ranks.entries()).sort((a,b)=>b[1]-a[1]).map(([id])=>id).slice(0,20);
      if (!ids.length) ids = ftsHits.slice(0, 20).map(h=>h.id);
      logs = fetchLogsByIds(db, ids);
    } catch {}

    // Fallback pseudo-logs if none found (DB disabled or empty match)
    if (!logs.length) {
      logs = rows.slice(0, 20).map(r => ({
        id: r.ts,
        ts: r.ts,
        endpoint: r.endpoint,
        model: r.model,
        region: r.region,
        status: r.status || (r.ok?200:null),
        text: `${r.status|| (r.ok?200:'?')} ${r.endpoint} latency=${r.latencyMs}ms model=${r.model||''} region=${r.region||''}`.trim()
      }));
    }

  // Build answer text (LLM optional, but contextual when LLM is off)
  const lowerQ = String(userMsg||'').toLowerCase();
  const chartIntent = /\b(pie|bar|chart|graph|visual|visualize|plot)\b/.test(lowerQ);
  let chartSpec = null; // chart specification for streaming route (mirrors non-stream)
  // Direct metric intents
  const slowestIntent = /(which|what)?\s*(is\s*)?(the\s*)?slow(est)?\s+endpoint/.test(lowerQ) || /slowest\s+endpoint/.test(lowerQ);
  let directAnswer = null; let directIntent = null;
  if (slowestIntent) {
    const groups = new Map();
    for (const r of rows) {
      if (!r.ok || typeof r.latencyMs !== 'number') continue;
      const ep = r.endpoint || '(unknown)';
      const arr = groups.get(ep) || []; arr.push(r.latencyMs); groups.set(ep, arr);
    }
    if (!groups.size) {
      directAnswer = 'No successful requests in range.';
    } else {
      const quant = (arr,q)=>{ if(!arr.length) return 0; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const b=Math.floor(pos); const rest=pos-b; return a[b+1]!==undefined ? a[b]+rest*(a[b+1]-a[b]) : a[b]; };
      const stats = Array.from(groups.entries()).map(([ep,arr])=>({ ep, count: arr.length, p95: Math.round(quant(arr,0.95)||0), p99: Math.round(quant(arr,0.99)||0), p50: Math.round(quant(arr,0.50)||0) }));
      const eligible = stats.filter(s=>s.count>=2);
      const ranking = (eligible.length?eligible:stats).sort((a,b)=> b.p95 - a.p95 || b.p99 - a.p99 || b.p50 - a.p50);
      const top = ranking[0];
      const second = ranking[1];
      if (top) directAnswer = `Slowest endpoint (by p95) is ${top.ep} (p95 ${top.p95} ms, p99 ${top.p99} ms, samples ${top.count}).` + (second?` Next: ${second.ep} (p95 ${second.p95} ms).`: '');
      else directAnswer = 'Unable to determine slowest endpoint.';
    }
    directIntent = 'slowest_endpoint';
  }
  const wantPopularityModel = /(most\s+(popular|used|common)|top\s+model|popular|populate)/.test(lowerQ);
  const wantJoke = /(\btell\b.*\bjoke\b|\bjoke\b|\bfunny\b|\blaugh\b)/.test(lowerQ);
  const topStatuses = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', ');
  const rangeStr = `${new Date(from).toISOString()} → ${new Date(to).toISOString()}`;
  const epStr = endpoint ? ` for ${endpoint}` : '';
  const baseLine = `In ${rangeStr}${epStr}, total=${total}, ok=${ok} (SLI ${(sli*100).toFixed(2)}%). Latency p50=${p50??'–'}ms p95=${p95??'–'}ms p99=${p99??'–'}ms. Top statuses: ${topStatuses||'—'}.`;
  const want429 = /429|rate.?limit/.test(lowerQ);
  const wantError = /error|fail|5\d\d|4\d\d/.test(lowerQ);
  const wantLatency = /latency|slow|p95|p99|perf/.test(lowerQ);
  const wantCost = /cost|token/.test(lowerQ);
  const details = [];
  if (want429) { const c429 = rows.filter(r => (r.status||0)===429).length; details.push(`429s: ${c429}`); }
  if (wantError) { const errTop = Object.entries(byStatus).filter(([k])=>Number(k)>=400).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k,v])=>`${k}:${v}`).join(', '); if (errTop) details.push(`Top error statuses: ${errTop}`); }
  if (wantLatency) { const worst = rows.filter(r=>r.ok).sort((a,b)=>b.latencyMs-a.latencyMs).slice(0,3).map(r=>`${r.latencyMs}ms ${r.endpoint} ${r.model||''} ${r.region||''}`).join(' | '); if (worst) details.push(`Slowest ok: ${worst}`); }
  if (wantCost) { const tokTotal = rows.reduce((a,r)=>a+(r.tokensTotal||0),0); const tokPrompt = rows.reduce((a,r)=>a+(r.tokensPrompt||0),0); const tokComp = rows.reduce((a,r)=>a+(r.tokensCompletion||0),0); details.push(`Tokens total=${tokTotal} (prompt=${tokPrompt}, completion=${tokComp})`); }
  const logSnippet = logs.length ? `Top log: ${String(logs[0].text||'').slice(0,140)}` : '';
  // Popular model analysis when asked
  let popularityBlock = '';
  if (wantPopularityModel) {
    let topModels = [];
    try {
      if (db) {
        const params = { from, to };
        let sql = `SELECT model AS key, COUNT(1) AS c FROM logs_raw WHERE ts BETWEEN @from AND @to AND model IS NOT NULL AND model <> ''`;
        if (endpoint) { sql += ` AND endpoint = @endpoint`; params.endpoint = endpoint; }
        sql += ` GROUP BY model ORDER BY c DESC LIMIT 5`;
        const rowsM = db.prepare(sql).all(params);
        topModels = rowsM.map(r=>({ key: r.key, count: r.c }));
      }
    } catch {}
    if (!topModels.length) {
      const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k]=(acc[k]||0)+1; return acc; },{});
      topModels = Object.entries(counts).map(([k,v])=>({ key:k, count:v })).sort((a,b)=>b.count-a.count).slice(0,5);
    }
    const grand = topModels.reduce((a,x)=>a+x.count,0) || total || 1;
    if (topModels.length) {
      const lead = topModels[0];
      const share = ((lead.count/(grand||1))*100).toFixed(1);
      const rest = topModels.slice(1).map(m=>`${m.key}: ${m.count} (${((m.count/(grand||1))*100).toFixed(1)}%)`).join(', ');
      popularityBlock = `Most used model${epStr}: ${lead.key} — ${lead.count} calls (${share}%) in ${rangeStr}.` + (rest?` Next: ${rest}.`: '');
    } else {
      popularityBlock = `No model usage found in ${rangeStr}${epStr}.`;
    }
  }

  // Contextual data tables for diagram
  const dataTables = [];
  let dataContext = null;
  if (wantPopularityModel) {
    let topModels = [];
    try {
      if (db) {
        const params = { from, to };
        let sql = `SELECT model AS key, COUNT(1) AS c FROM logs_raw WHERE ts BETWEEN @from AND @to AND model IS NOT NULL AND model <> ''`;
        if (endpoint) { sql += ` AND endpoint = @endpoint`; params.endpoint = endpoint; }
        sql += ` GROUP BY model ORDER BY c DESC LIMIT 5`;
        const rowsM = db.prepare(sql).all(params);
        topModels = rowsM.map(r=>({ key: r.key, count: r.c }));
      }
    } catch {}
    if (!topModels.length) {
      const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k]=(acc[k]||0)+1; return acc; },{});
      topModels = Object.entries(counts).map(([k,v])=>({ key:k, count:v })).sort((a,b)=>b.count-a.count).slice(0,5);
    }
    const tbl = { name:'popular_models', rows: topModels.map(m=>[m.key, m.count]) };
    dataTables.push(tbl);
    dataContext = { table: 'popular_models', title: 'Most used models' };
  } else if (wantLatency) {
    const groups = new Map();
    for (const r of rows) {
      if (!r.ok || typeof r.latencyMs !== 'number') continue;
      const key = r.endpoint || '(unknown)';
      const arr = groups.get(key) || [];
      arr.push(r.latencyMs);
      groups.set(key, arr);
    }
    const quant = (arr,q)=>{ if(!arr.length) return 0; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const b=Math.floor(pos); const rest=pos-b; return a[b+1]!==undefined ? a[b]+rest*(a[b+1]-a[b]) : a[b]; };
    const items = Array.from(groups.entries()).map(([k,arr])=>[k, Math.round(quant(arr,0.95))]).sort((a,b)=>b[1]-a[1]).slice(0,7);
    if (items.length) {
      dataTables.push({ name:'latency_by_endpoint', rows: items });
      dataContext = { table: 'latency_by_endpoint', title: 'Endpoint p95 latency' };
    }
  } else if (wantError || want429) {
    dataContext = { table: 'errors_by_status', title: 'Errors by status' };
  } else if (wantCost) {
    dataContext = { table: 'tokens_summary', title: 'Tokens' };
  }

  let answer;
  if (directIntent==='slowest_endpoint' && directAnswer) {
    answer = directAnswer;
  } else {
    answer = wantPopularityModel
      ? [popularityBlock, details.join(' • '), logSnippet].filter(Boolean).join('\n')
      : [baseLine, details.join(' • '), logSnippet].filter(Boolean).join('\n');
  }
  const useLLM = body.llm === true && !!process.env.OPENAI_API_KEY;
  if (!useLLM && wantJoke) {
    answer = "Why do programmers prefer dark mode? Because light attracts bugs.";
  }
  // Construct chartSpec if requested
  if (!chartSpec && chartIntent) {
    const wantErrorsChart = /error|errors|fail|fails|failure|5\d\d|4\d\d/.test(lowerQ);
    const wantLatencyChart = /latency|slow|p95|p99|perf|performance/.test(lowerQ) || /endpoint/.test(lowerQ);
    if (wantErrorsChart) {
      const entries = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,8);
      if (entries.length) {
        chartSpec = { type: 'pie', title: 'Errors by Status', series: [{ name: 'status', labels: entries.map(e=>e[0]), values: entries.map(e=>e[1]) }], meta: { source: 'errors_by_status' } };
      } else {
        chartSpec = { type: 'pie', title: 'Errors by Status', series: [{ name: 'status', labels: [], values: [] }], meta: { source: 'errors_by_status', empty: true } };
      }
    } else if (wantLatencyChart) {
      const groups = new Map();
      for (const r of rows) { if (!r.ok || typeof r.latencyMs !== 'number') continue; const ep = r.endpoint||'(unknown)'; const arr = groups.get(ep)||[]; arr.push(r.latencyMs); groups.set(ep, arr); }
      const quant = (arr,q)=>{ if(!arr.length) return 0; const a=arr.slice().sort((x,y)=>x-y); const pos=(a.length-1)*q; const b=Math.floor(pos); const rest=pos-b; return a[b+1]!==undefined ? a[b]+rest*(a[b+1]-a[b]) : a[b]; };
      const stats = Array.from(groups.entries()).map(([ep,arr])=>({ ep, p95: Math.round(quant(arr,0.95)||0) })).sort((a,b)=>b.p95-a.p95).slice(0,8);
      if (stats.length) {
        chartSpec = { type: 'bar', title: 'Endpoint p95 latency (ms)', x: stats.map(s=>s.ep), y: stats.map(s=>s.p95), meta: { source: 'latency_by_endpoint', metric: 'p95_latency_ms' } };
      } else {
        chartSpec = { type: 'bar', title: 'Endpoint p95 latency (ms)', x: [], y: [], meta: { source: 'latency_by_endpoint', metric: 'p95_latency_ms', empty: true } };
      }
    }
  }
  if (directIntent && useLLM) {
    // Suppress LLM for deterministic direct intent
    body.llm = false;
  }
  let usedLLM = false;
  let llmModel = null; let llmTried = false; let llmStatus = null;
  let llmRoute = null; let llmFallback = null; // ensure defined for final write
  if (useLLM) {
      try {
        llmTried = true;
        let popularityFacts='';
        if (wantPopularityModel) {
          try {
            let facts = [];
            if (db) {
              const params = { from, to };
              let sql = `SELECT model AS key, COUNT(1) AS c FROM logs_raw WHERE ts BETWEEN @from AND @to AND model IS NOT NULL AND model <> ''`;
              if (endpoint) { sql += ` AND endpoint = @endpoint`; params.endpoint = endpoint; }
              sql += ` GROUP BY model ORDER BY c DESC LIMIT 10`;
              const rowsM = db.prepare(sql).all(params);
              facts = rowsM.map(r=>`${r.key}: ${r.c}`).join(', ');
            }
            if (!facts) {
              const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k] = (acc[k]||0)+1; return acc; },{});
              const ordered = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`${k}: ${v}`).join(', ');
              facts = ordered;
            }
            popularityFacts = `Model usage (count): ${facts}`;
          } catch {}
        }
        const { sys, ctx } = buildLLMPromptComponents({
          wantPopularityModel, wantJoke, userMsg, historyBlock,
          from, to, endpoint, total, ok, sli, p50, p95, p99,
          topStatuses, logs, popularityFacts
        });
  // Per-request override (body.model) allowed via same allowlist as non-stream route
  const MODEL_ALLOWLIST = new Set([
    'gpt-4.1-mini','gpt-4.1','gpt-4o-mini','gpt-4o','gpt-4o-realtime-preview',
    'o4-mini','o4','gpt-4.1-nano','gpt-4o-mini-translate','chatgpt-4o-latest',
    'gpt-5','gpt-5-mini','gpt-5-nano',
    'text-embedding-3-small','text-embedding-3-large','omni-moderation-latest'
  ]);
  const reqModelRaw = (typeof body.model === 'string') ? body.model.trim() : '';
  let overrideModel = null;
  if (reqModelRaw && MODEL_ALLOWLIST.has(reqModelRaw)) overrideModel = reqModelRaw;
  llmModel = overrideModel || process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  async function callResponses(modelName){
    const isG5 = /^gpt-5/.test(modelName);
    let payload;
    if (isG5) {
      payload = { model: modelName, input:[ { role:'system', content:[{ type:'input_text', text: sys }] }, { role:'user', content:[{ type:'input_text', text: ctx }] } ] };
    } else {
  payload = { model: modelName, input:[ { role:'system', content:[{ type:'input_text', text: sys }] }, { role:'user', content:[{ type:'input_text', text: ctx }] } ], max_output_tokens: 450, temperature: 0.2 };
    }
    return fetch('https://api.openai.com/v1/responses', { method:'POST', headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(payload) });
  }
  async function callChat(modelName){
    const isG5 = /^gpt-5/.test(modelName);
    let payload;
    if (isG5) {
      payload = { model: modelName, messages:[ { role:'system', content: sys }, { role:'user', content: ctx } ] };
    } else {
  payload = { model: modelName, messages:[ { role:'system', content: sys }, { role:'user', content: ctx } ], max_tokens: 450, temperature: 0.2 };
    }
    return fetch('https://api.openai.com/v1/chat/completions', { method:'POST', headers:{ 'Content-Type':'application/json','Authorization':`Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify(payload) });
  }
  const preferChat = /^gpt-5/.test(llmModel);
  try {
    let primaryResp; let primaryRoute;
    if (preferChat) { primaryRoute='chat.completions'; primaryResp = await callChat(llmModel); }
    else { primaryRoute='responses'; primaryResp = await callResponses(llmModel); }
    llmStatus = primaryResp.status; llmRoute = primaryRoute;
    if (primaryResp.ok) {
      const j = await primaryResp.json();
      const txt = primaryRoute==='responses'? extractResponsesText(j) : extractChatCompletionsText(j);
      if (txt) { answer = txt; usedLLM = true; }
    } else {
      if (primaryResp.status>=400 && primaryResp.status<500) {
        let primaryErrSnippet=null; try { primaryErrSnippet=(await primaryResp.text()).slice(0,300); } catch(_){ }
        llmFallback = { reason:'primary_failed', primaryRoute, primaryStatus: primaryResp.status, primaryErr: primaryErrSnippet };
        try {
          const altRoute = primaryRoute==='responses' ? 'chat.completions' : 'responses';
          const altResp = primaryRoute==='responses'? await callChat(llmModel) : await callResponses(llmModel);
          llmStatus = altResp.status; llmRoute = altRoute;
          if (altResp.ok) {
            const j2 = await altResp.json();
            const txt2 = altRoute==='responses'? extractResponsesText(j2) : extractChatCompletionsText(j2);
            if (txt2) { answer = txt2; usedLLM = true; }
            llmFallback.altSucceeded = true;
          } else { let altErrSnippet=null; try { altErrSnippet=(await altResp.text()).slice(0,300); } catch(_){ } llmFallback.altStatus = altResp.status; if(altErrSnippet) llmFallback.altErr = altErrSnippet; }
        } catch(eAlt){ llmFallback.altError = String(eAlt?.message||eAlt); }
      }
      if (!usedLLM && llmModel !== 'gpt-4o-mini') {
        try {
          const fbModel='gpt-4o-mini';
          const fbResp = await callResponses(fbModel);
          llmStatus = fbResp.status; llmRoute = 'responses';
          llmFallback = { ...(llmFallback||{}), finalFallbackModel: fbModel, finalFallbackRoute:'responses', finalFallbackStatus: fbResp.status };
          if (fbResp.ok) { const jf = await fbResp.json(); const txtf = extractResponsesText(jf); if (txtf) { answer = txtf; usedLLM = true; llmModel = fbModel; } }
        } catch(eFb){ llmFallback = { ...(llmFallback||{}), finalFallbackError: String(eFb?.message||eFb) }; }
      }
    }
  if (should('info')) log.info('[ai/chat/stream] LLM', { tried: llmTried, used: usedLLM, status: llmStatus, model: llmModel, route: llmRoute, fallback: llmFallback||null });
  } catch(eAll){
    llmFallback = { ...(llmFallback||{}), outerError: String(eAll?.message||eAll) };
    console.warn('[ai/chat/stream] LLM failed', String(eAll?.message||eAll));
  }
      } catch(e) {
        console.warn('[ai/chat/stream] LLM failed', String(e?.message||e));
      }
    }

    function write(obj){ try { res.write(JSON.stringify(obj)+'\n'); } catch(_){} }
    // Stream in small chunks (words) so UI updates progressively
  const parts = String(answer).split(/(\s+)/); // keep whitespace
    for (const p of parts) write({ delta: p });
    const citations = { logs: logs.map(l=>l.id), metrics: ['summary'] };
    const tokensTotal = rows.reduce((a,r)=>a+(r.tokensTotal||0),0);
    const tokensPrompt = rows.reduce((a,r)=>a+(r.tokensPrompt||0),0);
    const tokensCompletion = rows.reduce((a,r)=>a+(r.tokensCompletion||0),0);
    const topErrs = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const summary = {
      range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      endpoint: endpoint || 'all',
      totals: { total, ok, sli },
      latency: { p50: p50||0, p95: p95||0, p99: p99||0 },
      errors: topErrs,
      tokens: { prompt: tokensPrompt, completion: tokensCompletion, total: tokensTotal }
    };
    function buildNarrative(){
      const sliPct = (sli*100).toFixed(2);
      const health = sli>=0.995? 'SLA likely being met' : sli>=0.985? 'SLA slightly degraded' : 'SLA degraded';
      const errTopEntry = Object.entries(byStatus).sort((a,b)=>b[1]-a[1])[0];
      let errMsg = '';
      if (errTopEntry){
        const [code, cnt] = errTopEntry; const rate = total? ((cnt/total)*100).toFixed(1) : '0.0';
        if (String(code)==='429') errMsg = `Rate limiting (${rate}% of requests) is the top error.`;
        else if (/^5\d\d$/.test(String(code))) errMsg = `Server errors ${code} are elevated (${rate}%).`;
        else if (Number(code)>=400) errMsg = `Client errors ${code} observed (${rate}%).`;
      }
      const latMsg = (p95!=null && p99!=null) ? `Latency is stable with p95 ${p95} ms and p99 ${p99} ms.` : '';
      let extra='';
      if (wantPopularityModel && popularityBlock) extra = popularityBlock;
      else if (wantLatency){
        const slowest = rows.filter(r=>r.ok).sort((a,b)=>b.latencyMs-a.latencyMs).slice(0,2).map(r=>`${r.latencyMs} ms ${r.endpoint}`).join('; ');
        if (slowest) extra = `Slowest successful calls: ${slowest}.`;
      } else if (wantError && errTopEntry){ extra = `Top statuses: ${topStatuses}.`; }
      const parts = [ `${health} (SLI ${sliPct}%).`, latMsg, errMsg, extra ].filter(Boolean);
      return parts.join(' ');
    }
    const data = { tables: [
      { name:'errors_by_status', rows: Object.entries(byStatus) },
      { name:'lat_percentiles', rows: [['p50', p50||0], ['p95', p95||0], ['p99', p99||0]] },
      { name:'tokens_summary', rows: [['prompt', tokensPrompt], ['completion', tokensCompletion], ['total', tokensTotal]] }
  ].concat(dataTables), context: dataContext };
    // Evidence objects (up to 10) mirroring non-stream endpoint
    const evidence = logs.slice(0,10).map(l=>({
      id: l.id,
      ts: l.ts,
      endpoint: l.endpoint || null,
      model: l.model || null,
      region: l.region || null,
      status: l.status || null,
      text: (l.text||'').slice(0,400)
    }));
  write({ done: true, citations, evidence, data, summary, narrative: usedLLM ? answer : buildNarrative(), usedLLM, llmModel, llmTried, llmStatus, llmRoute, llmFallback, chartSpec });
    try { res.end(); } catch(_){}
  } catch (e) {
    console.error('[ai/chat/stream] failed', e);
    try { res.status(500).json({ error: String(e) }); } catch(_){}
  }
});

// (moved) 404 handler goes at the very end, after all routes & static

// Ingestion endpoint (Phase M2)
app.post('/ingest/trace', async (req, res) => {
  try {
    const ingestKey = process.env.INGEST_API_KEY || process.env.INGEST_TOKEN;
    if (ingestKey) {
      const provided = req.header('x-api-key') || req.header('authorization')?.replace(/^Bearer\s+/i,'');
      if (provided !== ingestKey) return res.status(401).json({ error: 'unauthorized' });
    }
    const trace = normalizeTrace(req.body || {});
    // persist
    if (db && typeof db.prepare === 'function') {
      try {
        const stmt = db.prepare(`INSERT INTO probe_results (ts, ok, status, latency_ms, endpoint, model, region, err_type, tokens_total, tokens_prompt, tokens_completion, resp_bytes) VALUES (@ts,@ok,@status,@latencyMs,@endpoint,@model,@region,@errType,@tokensTotal,@tokensPrompt,@tokensCompletion,@respBytes)`);
        stmt.run({ ...trace, ok: trace.ok ? 1 : 0 });
      } catch (e) {
        console.error('[ingest] sqlite insert failed', e.message);
      }
    }
    // push to memory store
    store.push(trace);
    res.json({ ok: true });
  } catch (e) {
    console.error('[ingest] failed', e);
    res.status(400).json({ error: String(e) });
  }
});
app.get('/status', async (req, res) => {
  const window = Number(req.query.window || '60');
  const endpointParam = req.query.endpoint; // may be single or comma-separated
  const endpointList = endpointParam ? String(endpointParam).split(',').filter(Boolean) : null;
  const from = req.query.from ? Number(req.query.from) : null; // epoch ms
  const to = req.query.to ? Number(req.query.to) : null;
  const useAbsolute = from && to && to > from;
  if (db && (fetchWindow || fetchRange)) {
    try {
      let rows;
      if (useAbsolute) {
        if (endpointList && endpointList.length === 1) rows = fetchRange(db, { from, to, endpoint: endpointList[0] });
        else rows = fetchRange(db, { from, to });
      } else {
        if (endpointList && endpointList.length === 1) rows = fetchWindow(db, { windowMinutes: window, endpoint: endpointList[0] });
        else rows = fetchWindow(db, { windowMinutes: window });
      }
      const temp = new MetricsStore({ capacity: rows.length + 10 });
      rows.forEach(r => temp.push(r));
  let summary = temp.summary({ windowMinutes: window, from: useAbsolute ? from : undefined, to: useAbsolute ? to : undefined });
      if (endpointList && endpointList.length !== 1) {
        summary.endpoints = Object.fromEntries(Object.entries(summary.endpoints).filter(([k]) => endpointList.includes(k)));
      }
      summary.range = useAbsolute ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : undefined;
      return res.json(summary);
    } catch (e) {
      console.error('[status] db fetch failed, falling back to memory', e);
    }
  }
  let summary = store.summary({ windowMinutes: window, from, to });
  if (endpointList) summary.endpoints = Object.fromEntries(Object.entries(summary.endpoints).filter(([k]) => endpointList.includes(k)));
  res.json(summary);
});

// Raw trace points endpoint
app.get('/traces', async (req, res) => {
  const window = Number(req.query.window || '60');
  const endpointParam = req.query.endpoint; // may be single or comma-separated
  const endpointList = endpointParam ? String(endpointParam).split(',').filter(Boolean) : null;
  const from = req.query.from ? Number(req.query.from) : null; // epoch ms
  const to = req.query.to ? Number(req.query.to) : null;
  const limit = Math.min(Number(req.query.limit || '200'), 1000);
  const errorsOnly = req.query.errorsOnly === '1';
  const slowMs = req.query.slowMs ? Number(req.query.slowMs) : null;
  const useAbsolute = from && to && to > from;
  // Cursor pagination (ts_cursor + direction=prev|next, default prev meaning earlier than cursor)
  const cursor = req.query.cursor ? Number(req.query.cursor) : null;
  const direction = req.query.direction === 'next' ? 'next' : 'prev';
  let rows = [];
  try {
    if (db && (fetchWindow || fetchRange)) {
      if (useAbsolute) {
        if (endpointList && endpointList.length === 1) rows = fetchRange(db, { from, to, endpoint: endpointList[0] });
        else rows = fetchRange(db, { from, to });
      } else {
        if (endpointList && endpointList.length === 1) rows = fetchWindow(db, { windowMinutes: window, endpoint: endpointList[0] });
        else rows = fetchWindow(db, { windowMinutes: window });
      }
    } else {
      const now = Date.now();
      const cutoff = useAbsolute ? from : (now - window * 60000);
      rows = store.points.filter(p => p.ts >= cutoff && (!useAbsolute || p.ts <= (to || now)));
    }
  } catch (e) {
    console.error('[traces] query failed', e);
  }
  if (endpointList) rows = rows.filter(r => endpointList.includes(r.endpoint));
  if (errorsOnly) rows = rows.filter(r => !r.ok);
  if (slowMs != null) rows = rows.filter(r => r.latencyMs >= slowMs);
  // sort desc by ts for consistent base
  rows.sort((a,b)=>b.ts - a.ts);
  // Apply cursor window
  if (cursor) {
    if (direction === 'prev') {
      rows = rows.filter(r => r.ts < cursor); // earlier than cursor
    } else {
      rows = rows.filter(r => r.ts > cursor); // newer than cursor
    }
  }
  const total = rows.length;
  const page = rows.slice(0, limit);
  const mapped = page.map(r => ({
    ts: r.ts,
    iso: new Date(r.ts).toISOString(),
    endpoint: r.endpoint,
    status: r.status,
    ok: !!r.ok,
    latencyMs: r.latencyMs,
    model: r.model,
    region: r.region,
    errType: r.errType || null,
    tokensTotal: r.tokensTotal ?? null,
    tokensPrompt: r.tokensPrompt ?? null,
    tokensCompletion: r.tokensCompletion ?? null,
    respBytes: r.respBytes ?? null
  }));
  const nextCursor = mapped.length ? mapped[mapped.length - 1].ts : null; // for older
  const prevCursor = mapped.length ? mapped[0].ts : null; // for newer
  res.json({ total, returned: mapped.length, limit, windowMinutes: window, cursor: { prev: prevCursor, next: nextCursor }, direction, range: useAbsolute ? { from: new Date(from).toISOString(), to: new Date(to).toISOString() } : undefined, points: mapped });
});

// Lightweight latency histogram endpoint (bucketed) for given window or absolute range
app.get('/latency_histogram', async (req, res) => {
  const window = Number(req.query.window || '60');
  const from = req.query.from ? Number(req.query.from) : null;
  const to = req.query.to ? Number(req.query.to) : null;
  const endpoint = req.query.endpoint || null;
  const useAbsolute = from && to && to > from;
  let rows = [];
  try {
    if (db && (fetchWindow || fetchRange)) {
      if (useAbsolute) rows = fetchRange(db, { from, to, endpoint });
      else rows = fetchWindow(db, { windowMinutes: window, endpoint });
    } else {
      const now = Date.now();
      const cutoff = useAbsolute ? from : (now - window * 60000);
      rows = store.points.filter(p => p.ts >= cutoff && (!useAbsolute || p.ts <= (to || now)) && (!endpoint || p.endpoint === endpoint));
    }
  } catch(e) {
    console.error('[histogram] query failed', e);
  }
  const okLatencies = rows.filter(r=>r.ok).map(r=>r.latencyMs).sort((a,b)=>a-b);
  if (!okLatencies.length) return res.json({ buckets: [], total: 0 });
  // Freedman–Diaconis or simple sqrt rule to choose bucket count
  const bucketCount = Math.min(20, Math.ceil(Math.sqrt(okLatencies.length)) + 5);
  const min = okLatencies[0];
  const max = okLatencies[okLatencies.length -1];
  const span = Math.max(1, max - min);
  const width = span / bucketCount;
  const buckets = Array.from({length: bucketCount}, (_,i)=>({ start: Math.round(min + i*width), end: Math.round(min + (i+1)*width), count: 0 }));
  for (const l of okLatencies) {
    const idx = Math.min(bucketCount-1, Math.floor((l - min)/width));
    buckets[idx].count++;
  }
  res.json({ total: okLatencies.length, min, max, buckets });
});

// Incidents endpoint (optional). If public/incidents.json exists, return its incidents, filtered by ?from&?to (epoch ms)
app.get('/incidents', async (req, res) => {
  try {
    const filePath = path.join(__dirname, '../public/incidents.json');
    const raw = await fs.readFile(filePath, 'utf8');
    let incidents = JSON.parse(raw);
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;
    if (from || to) {
      const f = from ?? -Infinity;
      const t = to ?? Infinity;
      incidents = incidents.filter(x => x.end >= f && x.start <= t);
    }
    res.json(incidents);
  } catch (e) {
    // If no incidents file or parse error, return empty list
    res.json([]);
  }
});

// Basic time series: bucketed counts and latency percentiles across a time window or absolute range
app.get('/timeseries', async (req, res) => {
  try {
    const windowMin = Number(req.query.window || '60');
    const from = req.query.from ? Number(req.query.from) : null;
    const to = req.query.to ? Number(req.query.to) : null;
    const endpointParam = req.query.endpoint; // may be single or comma-separated
    const endpointList = endpointParam ? String(endpointParam).split(',').filter(Boolean) : null;
    const stepSec = Math.max(10, Math.min(3600, Number(req.query.stepSec || '60')));
    const useAbsolute = from && to && to > from;
    const now = Date.now();
    const rangeFrom = useAbsolute ? from : (now - windowMin * 60000);
    const rangeTo = useAbsolute ? to : now;

    let rows = [];
    if (db && (fetchWindow || fetchRange)) {
      if (useAbsolute) {
        if (endpointList && endpointList.length === 1) rows = fetchRange(db, { from: rangeFrom, to: rangeTo, endpoint: endpointList[0] });
        else rows = fetchRange(db, { from: rangeFrom, to: rangeTo });
      } else {
        if (endpointList && endpointList.length === 1) rows = fetchWindow(db, { windowMinutes: windowMin, endpoint: endpointList[0] });
        else rows = fetchWindow(db, { windowMinutes: windowMin });
      }
    } else {
      rows = store.points.filter(p => p.ts >= rangeFrom && p.ts <= rangeTo);
    }
    if (endpointList) rows = rows.filter(r => endpointList.includes(r.endpoint));

    const stepMs = stepSec * 1000;
    const bucketCount = Math.max(1, Math.ceil((rangeTo - rangeFrom) / stepMs));
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
      t: rangeFrom + i * stepMs,
      total: 0,
      ok: 0,
      _lat: []
    }));

    for (const r of rows) {
      const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((r.ts - rangeFrom) / stepMs)));
      const b = buckets[idx];
      b.total++;
      if (r.ok) {
        b.ok++;
        if (typeof r.latencyMs === 'number') b._lat.push(r.latencyMs);
      }
    }

    function quantile(arr, q) {
      if (!arr.length) return null;
      const a = arr.slice().sort((x, y) => x - y);
      const pos = (a.length - 1) * q;
      const base = Math.floor(pos);
      const rest = pos - base;
      if (a[base + 1] !== undefined) return a[base] + rest * (a[base + 1] - a[base]);
      return a[base];
    }

    const out = buckets.map(b => ({
      t: b.t,
      total: b.total,
      ok: b.ok,
      p50: quantile(b._lat, 0.5),
      p95: quantile(b._lat, 0.95),
      p99: quantile(b._lat, 0.99)
    }));

    res.json({
      stepSec,
      from: new Date(rangeFrom).toISOString(),
      to: new Date(rangeTo).toISOString(),
      buckets: out
    });
  } catch (e) {
    console.error('[timeseries] failed', e);
    res.status(500).json({ error: String(e) });
  }
});

// Health endpoint for quick checks
app.get('/healthz', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use('/', express.static(path.join(__dirname, '../public')));

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
  log.info(`[status] listening on http://localhost:${port}`);
  log.info(`[probe] interval=${intervalSec}s model=${model} region=${region}`);
    try {
      const stack = app?._router?.stack || [];
      const routes = [];
      for (const layer of stack) {
        if (layer.route) {
          const path = layer.route?.path;
          const methods = Object.keys(layer.route.methods||{}).join(',').toUpperCase();
          routes.push(`${methods} ${path}`);
        }
      }
  if (should('debug')) log.debug('[routes]', routes.join(' | '));
    } catch(_) {}
  });
}

// Final 404 handler (after static). Helps debug wrong paths during integration.
app.use((req, res) => {
  console.warn('[404]', req.method, req.originalUrl);
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

export default app;
