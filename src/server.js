import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetricsStore } from './metricsStore.js';
import { initOTel } from './otel.js';
import { ProbeRunner } from './probe.js';
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
    console.log('[db] sqlite ready');
  } catch (e) {
    console.warn('[db] sqlite init failed', e.message);
  }
} else if (!enableDb) {
  console.log('[db] disabled (set ENABLE_DB=1 to enable persistence)');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();

// Metrics store & OTel init
export const store = new MetricsStore({ capacity: 1000 });
initOTel({ store });

// Probe setup
const intervalSec = Number(process.env.PROBE_INTERVAL_SEC || '60');
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const region = process.env.PROBE_REGION || 'us-west-1';
const probe = new ProbeRunner({ store, intervalSec, model, db, persist: !!db });
if (process.env.NODE_ENV !== 'test') probe.start();

// Prevent caching of API responses
app.use((req, res, next) => {
  if (req.path.startsWith('/status') || req.path.startsWith('/traces') || req.path.startsWith('/latency_histogram') || req.path.startsWith('/debug')) {
    res.set('Cache-Control', 'no-store');
  }
  next();
});

// Routes
app.get('/debug/probe', (req, res) => {
  try {
    const cfg = probe.getConfig();
    const last = store.points.slice(-50);
    res.json({ config: cfg, lastPoints: last });
  } catch (e) {
    res.status(500).json({ error: String(e) });
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

app.use('/', express.static(path.join(__dirname, '../public')));

const port = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'test') {
  app.listen(port, () => {
    console.log(`[status] listening on http://localhost:${port}`);
    console.log(`[probe] interval=${intervalSec}s model=${model} region=${region}`);
  });
}

export default app;
