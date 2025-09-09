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
    console.log('[db] sqlite ready');
  } catch (e) {
    console.warn('[db] sqlite init failed', e.message);
  }
} else if (!enableDb) {
  console.log('[db] disabled (set ENABLE_DB=1 to enable persistence)');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.use(express.json({ limit: '1mb' }));

// Basic request logger for debugging (method, path, status, duration)
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    console.log(`[http] ${res.statusCode} ${req.method} ${req.originalUrl} ${ms}ms`);
  });
  next();
});

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

// Probe setup
const intervalSec = Number(process.env.PROBE_INTERVAL_SEC || '60');
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const region = process.env.PROBE_REGION || 'us-west-1';
const probe = new ProbeRunner({ store, intervalSec, model, db, persist: !!db });
if (process.env.NODE_ENV !== 'test') probe.start();

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
  synthetics: { enabled: true },
      probe: { intervalSec, model, region }
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message||e) });
  }
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

app.get('/logs/sim/start', requireIngestKey, async (req,res)=>{
  noStore(res);
  if (!ENABLE_AI) return res.status(400).json({ error:'ENABLE_AI=1 required' });
  if (!enableDb || !db) return res.status(400).json({ error:'ENABLE_DB=1 required' });
  if (logSimTimer) return res.json({ running:true });
  const { insertLogs } = await import('./db.js');
  logSimTimer = setInterval(()=>{
    try { const batch=generateSyntheticLogs(5+Math.floor(Math.random()*20)); insertLogs(db,batch); } catch(e){ console.warn('[logs/sim]', e.message); }
  }, LOG_SIM_INTERVAL_MS);
  console.log(`[logs/sim] started ${LOG_SIM_INTERVAL_MS}ms`);
  res.json({ started:true, intervalMs: LOG_SIM_INTERVAL_MS });
});

app.get('/logs/sim/stop', requireIngestKey, (req,res)=>{
  noStore(res);
  if (logSimTimer){ clearInterval(logSimTimer); logSimTimer=null; console.log('[logs/sim] stopped'); }
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
    console.log(`[logs/sim] auto-started ${LOG_SIM_INTERVAL_MS}ms`);
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
  console.log('[ai/index/logs] starting');
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
      console.log(`[ai/index/auto] indexed ${rows.length}`);
    }catch(e){ console.warn('[ai/index/auto] tick failed', e.message); }
  };
  embedIndexTimer = setInterval(tick, EMB_INDEX_INTERVAL_MS);
  console.log(`[ai/index/auto] started ${EMB_INDEX_INTERVAL_MS}ms`);
  res.json({ started:true, intervalMs: EMB_INDEX_INTERVAL_MS });
});

app.get('/ai/index/auto/stop', requireIngestKey, (req,res)=>{
  noStore(res);
  if (embedIndexTimer){ clearInterval(embedIndexTimer); embedIndexTimer=null; console.log('[ai/index/auto] stopped'); }
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

function normalizeSynthSpec(spec){
  const out = {
    name: String(spec?.name || 'Synthetic Monitor'),
    schedule: spec?.schedule || 'manual',
    startUrl: String(spec?.startUrl || spec?.url || ''),
    timeoutMs: Number(spec?.timeoutMs || 30000),
    steps: Array.isArray(spec?.steps) ? spec.steps : []
  };
  out.steps = out.steps.map(s=>({
    action: String(s?.action||'').toLowerCase(),
    url: s?.url ? String(s.url) : undefined,
    selector: s?.selector ? String(s.selector) : undefined,
    text: s?.text != null ? String(s.text) : undefined,
    enter: s?.enter ? true : false,
    timeoutMs: s?.timeoutMs!=null ? Number(s.timeoutMs) : undefined,
    any: s?.any ? true : false
  })).filter(s=>s.action);
  return out;
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
  "schedule": "manual" | "every_5m" | "every_15m" | "hourly",
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
  }>
}\nRules: Prefer robust CSS selectors (textarea, input[type=\"text\"], button, [role=\"button\"], etc). For \"type\", include selector and text. If pressing enter is needed, set enter: true. For assertions, include a broad selector like \"body\". Output ONLY the JSON.`;
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
    const spec = normalizeSynthSpec(req.body?.spec||{});
    if(!spec.startUrl && !spec.steps.some(s=>s.action==='goto' && s.url)) return res.status(400).json({ error:'startUrl or first goto step required' });
    const id = synthNextId++;
    const m = { id, name: spec.name || `Monitor ${id}`, spec, createdAt: Date.now() };
    synthMonitors.push(m);
    res.json({ id, monitor: m });
  }catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// List monitors
app.get('/synthetics', (req,res)=>{
  noStore(res);
  res.json({ items: synthMonitors.map(m=>({ id:m.id, name:m.name, createdAt:m.createdAt })) });
});

// Run a monitor once
app.post('/synthetics/:id/run', async (req,res)=>{
  noStore(res);
  try{
    const id = Number(req.params.id);
    const m = synthMonitors.find(x=>x.id===id);
    if(!m) return res.status(404).json({ error:'not_found' });
    const runId = synthRunNextId++;
    const startedAt = Date.now();
    const result = await runSyntheticMonitor(m.spec, runId);
    const rec = { id: runId, monitorId: id, startedAt, finishedAt: Date.now(), ok: !!result.ok, statusText: result.statusText||'', screenshot: result.screenshot||null, logs: result.logs||[] };
    synthRuns.unshift(rec);
    res.json(rec);
  }catch(e){ res.status(500).json({ error:String(e?.message||e) }); }
});

// List runs
app.get('/synthetics/runs', (req,res)=>{
  noStore(res);
  res.json({ items: synthRuns.slice(0,50) });
});

async function runSyntheticMonitor(spec, runId){
  const logs = [];
  const log = (m)=> logs.push({ ts: Date.now(), msg: m });
  await ensureSynthDir();
  const fileRel = `synth/run-${runId}.png`;
  const fileAbs = path.join(__dirname, '../public', fileRel);
  // Try Playwright first
  try{
    const pw = await import('playwright').catch(()=>null);
    if (pw && pw.chromium) {
      const browser = await pw.chromium.launch({ headless: true });
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await ctx.newPage();
      const timeout = Number(spec.timeoutMs||30000);
      const startUrl = spec.startUrl || (spec.steps.find(s=>s.action==='goto')?.url) || '';
      if(startUrl){ log(`goto ${startUrl}`); await page.goto(startUrl, { timeout }); }
      for (const step of spec.steps){
        const t = step.timeoutMs || timeout;
        if (step.action === 'goto' && step.url){ log(`goto ${step.url}`); await page.goto(step.url, { timeout: t }); }
        else if (step.action === 'click' && step.selector){ log(`click ${step.selector}`); await page.click(step.selector, { timeout: t }); }
        else if (step.action === 'type' && step.selector){ log(`type ${step.selector} ← ${step.text||''}`); await page.fill(step.selector, String(step.text||''), { timeout: t }); if(step.enter){ await page.keyboard.press('Enter'); } }
        else if (step.action === 'waitFor' && step.selector){ log(`waitFor ${step.selector}`); await page.waitForSelector(step.selector, { timeout: t }); }
        else if (step.action === 'assertTextContains'){ const sel = step.selector || 'body'; const txt = String(step.text||'').toLowerCase(); log(`assertTextContains ${sel} ~ ${txt}`); const content = await page.locator(sel).first().innerText({ timeout: t }).catch(async()=> (await page.content())); const ok = String(content||'').toLowerCase().includes(txt); if(!ok) throw new Error(`assert failed: missing text`); }
      }
      await page.screenshot({ path: fileAbs, fullPage: true });
      await browser.close();
      return { ok: true, statusText: 'ok', screenshot: '/'+fileRel, logs };
    }
  }catch(e){ log('playwright failed: '+String(e?.message||e)); }
  // Fallback: simple HTTP fetch
  try{
    const startUrl = spec.startUrl || (spec.steps.find(s=>s.action==='goto')?.url) || '';
    if (!startUrl) return { ok:false, statusText:'no_url', logs };
    log(`fetch ${startUrl}`);
    const r = await fetch(startUrl);
    const text = await r.text();
    const assertStep = spec.steps.find(s=>s.action==='assertTextContains');
    if (assertStep && assertStep.text) {
      const ok = text.toLowerCase().includes(String(assertStep.text).toLowerCase());
      return { ok, statusText: ok?'ok':'assert_failed', screenshot:null, logs };
    }
    return { ok: r.ok, statusText: String(r.status), screenshot:null, logs };
  }catch(e){ log('fetch failed: '+String(e?.message||e)); return { ok:false, statusText:'fetch_failed', screenshot:null, logs }; }
}

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

// ===== Chat endpoint (non-stream PoC) =====
app.post('/ai/chat', async (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const userMsg = messages.length ? messages[messages.length - 1].content || '' : String(body.query || '');
    const endpoint = body.filters?.endpoint || null;
    const modelF = body.filters?.model || null;
    const regionF = body.filters?.region || null;
    const now = Date.now();
    const from = body.from ? Number(body.from) : (now - 60*60000);
    const to = body.to ? Number(body.to) : now;
  console.log('[ai/chat]', { llm: !!body.llm, endpoint, from, to, promptLen: (userMsg||'').length });

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

  // Intent detection
  const lowerQ = String(userMsg||'').toLowerCase();
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

    let answer = wantPopularityModel
      ? [popularityBlock, details.join(' • '), logSnippet].filter(Boolean).join('\n')
      : [baseLine, details.join(' • '), logSnippet].filter(Boolean).join('\n');
    // Build a friendly non-LLM narrative
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
    // Off-topic lightweight handling (no LLM): return a short, clean joke when explicitly asked
    if (!body.llm && wantJoke) {
      answer = "Why do programmers prefer dark mode? Because light attracts bugs.";
    }

  // Optional LLM enhancement when requested and configured
  let usedLLM = false;
  const useLLM = body.llm === true && !!process.env.OPENAI_API_KEY;
  let llmModel = null; let llmTried = false; let llmStatus = null;
  if (useLLM) {
      try {
        llmTried = true;
        const sys = wantPopularityModel
          ? `You are an SRE/analytics assistant. Answer the user's question directly using the provided context. If they ask for the most used model, identify the top model by count, include its share %, and list the next few. Keep it concise and explanatory.`
          : (wantJoke
            ? `Tell ONE short, clean, family-friendly programming joke. No preface, just the joke in one or two lines.`
            : `You are an SRE assistant. Summarize reliability for the given time window. Include: total, SLI%, p50/p95/p99, top error statuses, and a short recommendation. Keep it concise.`);
        // Prepare optional popularity facts for the LLM
        let popularityFacts = '';
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
              const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k]=(acc[k]||0)+1; return acc; },{});
              const ordered = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`${k}: ${v}`).join(', ');
              facts = ordered;
            }
            popularityFacts = `Model usage (count): ${facts}`;
          } catch {}
        }
        const ctx = wantJoke
          ? `User question: ${userMsg || '(none)'}\n`
          : (
            `Window: ${new Date(from).toISOString()} to ${new Date(to).toISOString()}\n`+
            `Endpoint: ${endpoint||'all'}\n`+
            (wantPopularityModel? `${popularityFacts}\n` :
              `Total: ${total}\nOK: ${ok}\nSLI: ${(sli*100).toFixed(2)}%\nLatency: p50=${p50??'–'}ms p95=${p95??'–'}ms p99=${p99??'–'}ms\nTop statuses: ${topStatuses||'—'}\n`)+
            `User question: ${userMsg || '(none)'}\n`+
            `Top logs: ${logs.slice(0,5).map(l=>`[${new Date(l.ts).toISOString()}] ${l.status} ${l.endpoint} ${l.model||''} ${l.region||''} ${String(l.text||'').slice(0,160)}`).join('\n')}`
          );
  llmModel = process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const r = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({
      model: llmModel,
            input: [
              { role: 'system', content: [ { type: 'input_text', text: sys } ] },
              { role: 'user', content: [ { type: 'input_text', text: ctx } ] }
            ],
            max_output_tokens: 300,
            temperature: 0.2
          })
        });
    llmStatus = r.status;
    if (r.ok) {
          const j = await r.json();
          const txt = extractResponsesText(j);
          if (txt) { answer = txt; usedLLM = true; }
        } else if (llmModel !== 'gpt-4o-mini') {
          // Fallback to a safe default model if env model failed
          try {
            const fallbackModel = 'gpt-4o-mini';
            const rf = await fetch('https://api.openai.com/v1/responses', {
              method: 'POST',
              headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
              body: JSON.stringify({
                model: fallbackModel,
                input: [
                  { role: 'system', content: [ { type: 'input_text', text: sys } ] },
                  { role: 'user', content: [ { type: 'input_text', text: ctx } ] }
                ],
                max_output_tokens: 300,
                temperature: 0.2
              })
            });
            llmStatus = rf.status; llmModel = fallbackModel;
            if (rf.ok) {
              const jf = await rf.json();
              const txt2 = extractResponsesText(jf);
              if (txt2) { answer = txt2; usedLLM = true; }
            }
          } catch {}
        }
    console.log('[ai/chat] LLM', { tried: llmTried, used: usedLLM, status: llmStatus, model: llmModel });
      } catch(e) {
        // fall back silently
    console.warn('[ai/chat] LLM failed', String(e?.message||e));
      }
    }

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
  const narrative = (usedLLM && answer) ? answer : buildNarrative();
  res.json({ answer, narrative, citations, data, summary, usedLLM, llmModel, llmTried, llmStatus });
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
    const endpoint = body.filters?.endpoint || null;
    const now = Date.now();
    const from = body.from ? Number(body.from) : (now - 60*60000);
    const to = body.to ? Number(body.to) : now;
  console.log('[ai/chat/stream]', { llm: !!body.llm, endpoint, from, to, promptLen: (userMsg||'').length });

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

  // Build answer text (LLM optional, but contextual when LLM is off)
  const lowerQ = String(userMsg||'').toLowerCase();
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

  let answer = wantPopularityModel
    ? [popularityBlock, details.join(' • '), logSnippet].filter(Boolean).join('\n')
    : [baseLine, details.join(' • '), logSnippet].filter(Boolean).join('\n');
  const useLLM = body.llm === true && !!process.env.OPENAI_API_KEY;
  if (!useLLM && wantJoke) {
    answer = "Why do programmers prefer dark mode? Because light attracts bugs.";
  }
  let usedLLM = false;
  let llmModel = null; let llmTried = false; let llmStatus = null;
  if (useLLM) {
      try {
        llmTried = true;
        const sys = wantPopularityModel
          ? `You are an SRE/analytics assistant. Answer the user's question directly using the provided context. If they ask for the most used model, identify the top model by count, include its share %, and list the next few. Keep it concise and explanatory.`
          : (wantJoke
            ? `Tell ONE short, clean, family-friendly programming joke. No preface, just the joke in one or two lines.`
            : `You are an SRE assistant. Summarize reliability for the given time window. Include: total, SLI%, p50/p95/p99, top error statuses, and a short recommendation. Keep it concise.`);
        let popularityFacts = '';
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
              const counts = rows.reduce((acc,r)=>{ const k=r.model||'(unknown)'; acc[k]=(acc[k]||0)+1; return acc; },{});
              const ordered = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([k,v])=>`${k}: ${v}`).join(', ');
              facts = ordered;
            }
            popularityFacts = `Model usage (count): ${facts}`;
          } catch {}
        }
        const ctx = wantJoke
          ? `User question: ${userMsg || '(none)'}\n`
          : (
            `Window: ${new Date(from).toISOString()} to ${new Date(to).toISOString()}\n`+
            `Endpoint: ${endpoint||'all'}\n`+
            (wantPopularityModel? `${popularityFacts}\n` :
              `Total: ${total}\nOK: ${ok}\nSLI: ${(sli*100).toFixed(2)}%\nLatency: p50=${p50??'–'}ms p95=${p95??'–'}ms p99=${p99??'–'}ms\nTop statuses: ${topStatuses||'—'}\n`)+
            `User question: ${userMsg || '(none)'}\n`+
            `Top logs: ${logs.slice(0,5).map(l=>`[${new Date(l.ts).toISOString()}] ${l.status} ${l.endpoint} ${l.model||''} ${l.region||''} ${String(l.text||'').slice(0,160)}`).join('\n')}`
          );
  llmModel = process.env.OPENAI_RESPONSES_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
        const r = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
          body: JSON.stringify({ model: llmModel, input: [
            { role: 'system', content: [ { type: 'input_text', text: sys } ] },
            { role: 'user', content: [ { type: 'input_text', text: ctx } ] }
          ], max_output_tokens: 400, temperature: 0.2 })
        });
    llmStatus = r.status;
  if (r.ok) { const j = await r.json(); const txt = extractResponsesText(j); if (txt) { answer = txt; usedLLM = true; } }
  else if (llmModel !== 'gpt-4o-mini') {
    try {
      const fallbackModel = 'gpt-4o-mini';
      const rf = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', headers: { 'Content-Type':'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        body: JSON.stringify({ model: fallbackModel, input: [
          { role: 'system', content: [ { type: 'input_text', text: sys } ] },
          { role: 'user', content: [ { type: 'input_text', text: ctx } ] }
        ], max_output_tokens: 400, temperature: 0.2 })
      });
      llmStatus = rf.status; llmModel = fallbackModel;
  if (rf.ok) { const jf = await rf.json(); const txt2 = extractResponsesText(jf); if (txt2) { answer = txt2; usedLLM = true; } }
    } catch {}
  }
        console.log('[ai/chat/stream] LLM', { tried: llmTried, used: usedLLM, status: llmStatus, model: llmModel });
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
  write({ done: true, citations, data, summary, narrative: usedLLM ? answer : buildNarrative(), usedLLM, llmModel, llmTried, llmStatus });
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
    console.log(`[status] listening on http://localhost:${port}`);
    console.log(`[probe] interval=${intervalSec}s model=${model} region=${region}`);
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
      console.log('[routes]', routes.join(' | '));
    } catch(_) {}
  });
}

// Final 404 handler (after static). Helps debug wrong paths during integration.
app.use((req, res) => {
  console.warn('[404]', req.method, req.originalUrl);
  res.status(404).json({ error: 'not_found', path: req.originalUrl });
});

export default app;
