import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export function openDb() {
  const file = process.env.DB_FILE || path.join(process.cwd(), 'data.db');
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch(_) {}
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS probe_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER,
    latency_ms INTEGER,
    endpoint TEXT NOT NULL,
    model TEXT,
    region TEXT,
    err_type TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_probe_ts ON probe_results(ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_probe_endpoint_ts ON probe_results(endpoint, ts);');
  // Attempt to add new columns (ignore failures if already exist)
  const alterStatements = [
    'ALTER TABLE probe_results ADD COLUMN tokens_total INTEGER',
    'ALTER TABLE probe_results ADD COLUMN tokens_prompt INTEGER',
    'ALTER TABLE probe_results ADD COLUMN tokens_completion INTEGER',
    'ALTER TABLE probe_results ADD COLUMN resp_bytes INTEGER'
  ];
  for (const stmt of alterStatements) {
    try { db.exec(stmt); } catch (_) { /* ignore */ }
  }
  return db;
}

export function insertProbe(db, point) {
  try {
  const stmt = db.prepare(`INSERT INTO probe_results (ts, ok, status, latency_ms, endpoint, model, region, err_type, tokens_total, tokens_prompt, tokens_completion, resp_bytes) VALUES (@ts,@ok,@status,@latencyMs,@endpoint,@model,@region,@errType,@tokensTotal,@tokensPrompt,@tokensCompletion,@respBytes)`);
    stmt.run({ ...point, ok: point.ok ? 1 : 0 });
  } catch (e) {
    console.error('[db] insert error', e.message);
  }
}

export function fetchWindow(db, { windowMinutes = 60, endpoint } = {}) {
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  let rows;
  if (endpoint) {
  rows = db.prepare(`SELECT ts, ok, status, latency_ms as latencyMs, endpoint, model, region, err_type as errType, tokens_total as tokensTotal, tokens_prompt as tokensPrompt, tokens_completion as tokensCompletion, resp_bytes as respBytes FROM probe_results WHERE ts >= ? AND endpoint = ?`).all(cutoff, endpoint);
  } else {
  rows = db.prepare(`SELECT ts, ok, status, latency_ms as latencyMs, endpoint, model, region, err_type as errType, tokens_total as tokensTotal, tokens_prompt as tokensPrompt, tokens_completion as tokensCompletion, resp_bytes as respBytes FROM probe_results WHERE ts >= ?`).all(cutoff);
  }
  // Convert ok integer to boolean
  rows.forEach(r => { r.ok = !!r.ok; });
  return rows;
}

export function fetchRange(db, { from, to, endpoint } = {}) {
  let rows;
  if (endpoint) {
  rows = db.prepare(`SELECT ts, ok, status, latency_ms as latencyMs, endpoint, model, region, err_type as errType, tokens_total as tokensTotal, tokens_prompt as tokensPrompt, tokens_completion as tokensCompletion, resp_bytes as respBytes FROM probe_results WHERE ts BETWEEN ? AND ? AND endpoint = ?`).all(from, to, endpoint);
  } else {
  rows = db.prepare(`SELECT ts, ok, status, latency_ms as latencyMs, endpoint, model, region, err_type as errType, tokens_total as tokensTotal, tokens_prompt as tokensPrompt, tokens_completion as tokensCompletion, resp_bytes as respBytes FROM probe_results WHERE ts BETWEEN ? AND ?`).all(from, to);
  }
  rows.forEach(r => { r.ok = !!r.ok; });
  return rows;
}

// ===== AI-centric logs schema and helpers =====
export function ensureLogsSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS logs_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    endpoint TEXT NOT NULL,
    model TEXT,
    region TEXT,
    level TEXT,
    status INTEGER,
    latency_ms INTEGER,
    tokens_prompt INTEGER,
    tokens_completion INTEGER,
    tokens_total INTEGER,
    err_type TEXT,
    text TEXT NOT NULL
  );`);
  // FTS5 table for keyword search (content-rowid attaches to logs_raw.id)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
    text,
    content='logs_raw',
    content_rowid='id'
  );`);
  db.exec('CREATE TABLE IF NOT EXISTS logs_vec (id INTEGER PRIMARY KEY, embedding BLOB NOT NULL, dim INTEGER NOT NULL);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs_raw(ts);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_logs_ep_ts ON logs_raw(endpoint, ts);');
}

// ===== Synthetics schema and helpers =====
export function ensureSynthSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS synth_monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    spec TEXT NOT NULL,
    schedule TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`);
  // Soft delete column (idempotent)
  try { db.exec('ALTER TABLE synth_monitors ADD COLUMN deleted INTEGER DEFAULT 0'); } catch (_) { /* ignore */ }
  db.exec(`CREATE TABLE IF NOT EXISTS synth_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    ok INTEGER,
    status_text TEXT,
    screenshot TEXT,
    logs TEXT,
    steps TEXT,
    FOREIGN KEY(monitor_id) REFERENCES synth_monitors(id)
  );`);
  // Attempt to add new column (ignore if exists)
  try { db.exec('ALTER TABLE synth_runs ADD COLUMN steps TEXT'); } catch(_) { }
  db.exec('CREATE INDEX IF NOT EXISTS idx_synth_runs_monitor_time ON synth_runs(monitor_id, started_at DESC);');
}

export function insertSynthMonitor(db, { name, spec, schedule, createdAt }) {
  const stmt = db.prepare(`INSERT INTO synth_monitors (name, spec, schedule, created_at, deleted) VALUES (@name, @spec, @schedule, @createdAt, 0)`);
  const info = stmt.run({ name, spec: JSON.stringify(spec), schedule, createdAt });
  return info.lastInsertRowid;
}

export function listSynthMonitors(db) {
  const rows = db.prepare(`SELECT id, name, schedule, created_at as createdAt, COALESCE(deleted,0) as deleted FROM synth_monitors ORDER BY id DESC`).all();
  return rows;
}

export function updateSynthSchedule(db, id, schedule) {
  db.prepare(`UPDATE synth_monitors SET schedule=@schedule WHERE id=@id`).run({ id, schedule });
}

export function updateSynthMonitorSpec(db, id, spec, schedule) {
  // Also update name if present inside spec
  let name = null;
  try { if (spec && typeof spec === 'object' && spec.name) name = String(spec.name); } catch(_){}
  if (name) {
    db.prepare(`UPDATE synth_monitors SET name=@name, spec=@spec, schedule=@schedule WHERE id=@id`).run({ id, name, spec: JSON.stringify(spec), schedule });
  } else {
    db.prepare(`UPDATE synth_monitors SET spec=@spec, schedule=@schedule WHERE id=@id`).run({ id, spec: JSON.stringify(spec), schedule });
  }
}

export function getSynthMonitor(db, id) {
  const row = db.prepare(`SELECT id, name, spec, schedule, created_at as createdAt, COALESCE(deleted,0) as deleted FROM synth_monitors WHERE id=@id`).get({ id });
  if (!row) return null;
  try { row.spec = JSON.parse(row.spec); } catch { row.spec = null; }
  return row;
}

export function deleteSynthMonitor(db, id) {
  const delRuns = db.prepare(`DELETE FROM synth_runs WHERE monitor_id=@id`);
  const delMon = db.prepare(`DELETE FROM synth_monitors WHERE id=@id`);
  const trx = db.transaction((idVal)=>{ delRuns.run({ id: idVal }); delMon.run({ id: idVal }); });
  trx(id);
}

export function softDeleteSynthMonitor(db, id) {
  db.prepare('UPDATE synth_monitors SET deleted=1 WHERE id=@id').run({ id });
}

export function restoreSynthMonitor(db, id) {
  db.prepare('UPDATE synth_monitors SET deleted=0 WHERE id=@id').run({ id });
}

export function insertSynthRun(db, run) {
  // If an id is provided, try to insert using that id for consistency with in-memory IDs
  if (run.id != null) {
    const stmtWithId = db.prepare(`INSERT INTO synth_runs (id, monitor_id, started_at, finished_at, ok, status_text, screenshot, logs, steps) VALUES (@id, @monitorId, @startedAt, @finishedAt, @ok, @statusText, @screenshot, @logs, @steps)`);
    try {
      const info = stmtWithId.run({ ...run, ok: run.ok ? 1 : 0, logs: JSON.stringify(run.logs || []), steps: JSON.stringify(run.steps || []) });
      return info.lastInsertRowid;
    } catch (e) {
      // Fallback: insert without explicit id (in case of conflict with existing ids)
    }
  }
  const stmt = db.prepare(`INSERT INTO synth_runs (monitor_id, started_at, finished_at, ok, status_text, screenshot, logs, steps) VALUES (@monitorId, @startedAt, @finishedAt, @ok, @statusText, @screenshot, @logs, @steps)`);
  const info = stmt.run({ ...run, ok: run.ok ? 1 : 0, logs: JSON.stringify(run.logs || []), steps: JSON.stringify(run.steps || []) });
  return info.lastInsertRowid;
}

export function getSynthRun(db, id) {
  const r = db.prepare(`SELECT id, monitor_id as monitorId, started_at as startedAt, finished_at as finishedAt, ok, status_text as statusText, screenshot, logs, steps FROM synth_runs WHERE id=@id`).get({ id });
  if (!r) return null;
  return { ...r, ok: !!r.ok, logs: safeParseJson(r.logs, []), steps: safeParseJson(r.steps, []) };
}

export function listSynthRuns(db, limit = 50) {
  const rows = db.prepare(`SELECT id, monitor_id as monitorId, started_at as startedAt, finished_at as finishedAt, ok, status_text as statusText, screenshot, logs, steps FROM synth_runs ORDER BY started_at DESC LIMIT @limit`).all({ limit });
  return rows.map(r => ({ ...r, ok: !!r.ok, logs: safeParseJson(r.logs, []), steps: safeParseJson(r.steps, []) }));
}

export function getLastRunForMonitor(db, monitorId) {
  const r = db.prepare(`SELECT id, started_at as startedAt, finished_at as finishedAt, ok, status_text as statusText FROM synth_runs WHERE monitor_id=@monitorId ORDER BY started_at DESC LIMIT 1`).get({ monitorId });
  if (!r) return null; return { ...r, ok: !!r.ok };
}

function safeParseJson(s, defVal) {
  try { return JSON.parse(s); } catch { return defVal; }
}

export function insertLogs(db, logs) {
  if (!logs || !logs.length) return [];
  const insert = db.prepare(`
    INSERT INTO logs_raw
      (ts, endpoint, model, region, level, status, latency_ms, tokens_prompt, tokens_completion, tokens_total, err_type, text)
    VALUES
      (@ts, @endpoint, @model, @region, @level, @status, @latency_ms, @tokens_prompt, @tokens_completion, @tokens_total, @err_type, @text)
  `);
  const insertFts = db.prepare(`INSERT INTO logs_fts(rowid, text) VALUES (?, ?)`);
  const ids = [];
  const trx = db.transaction((arr) => {
    for (const l of arr) {
      const row = {
        ts: Number(l.ts) || Date.now(),
        endpoint: String(l.endpoint || ''),
        model: l.model || null,
        region: l.region || null,
        level: l.level || null,
        status: l.status != null ? Number(l.status) : null,
        latency_ms: l.latency_ms != null ? Number(l.latency_ms) : null,
        tokens_prompt: l.tokens_prompt != null ? Number(l.tokens_prompt) : null,
        tokens_completion: l.tokens_completion != null ? Number(l.tokens_completion) : null,
        tokens_total: l.tokens_total != null ? Number(l.tokens_total) : null,
        err_type: l.err_type || null,
        text: String(l.text || '')
      };
      const info = insert.run(row);
      const id = info.lastInsertRowid;
      ids.push(id);
      insertFts.run(id, row.text);
    }
  });
  trx(logs);
  return ids;
}

export function selectLogsNeedingEmbedding(db, limit = 64, sinceTs = null) {
  const sql = `
    SELECT l.id, l.text
    FROM logs_raw l
    LEFT JOIN logs_vec v ON v.id = l.id
    WHERE v.id IS NULL
      ${sinceTs ? 'AND l.ts >= @sinceTs' : ''}
    ORDER BY l.id DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all({ limit, sinceTs });
}

export function upsertLogEmbedding(db, id, float32Embedding, dim) {
  const buf = Buffer.from(new Float32Array(float32Embedding).buffer);
  db.prepare(`
    INSERT INTO logs_vec (id, embedding, dim)
    VALUES (@id, @embedding, @dim)
    ON CONFLICT(id) DO UPDATE SET embedding=excluded.embedding, dim=excluded.dim
  `).run({ id, embedding: buf, dim });
}

export function fetchLogsByIds(db, ids) {
  if (!ids || !ids.length) return [];
  const rows = db.prepare(`SELECT * FROM logs_raw WHERE id IN (${ids.map(() => '?').join(',')})`).all(ids);
  const map = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => map.get(id)).filter(Boolean);
}

export function searchLogsFts(db, query, limit = 200) {
  if (!query || !query.trim()) return [];
  const q = /\s/.test(query) ? `"${query.replace(/"/g, '""')}"` : query;
  const rows = db.prepare(`
    SELECT rowid AS id, bm25(logs_fts) AS score
    FROM logs_fts
    WHERE logs_fts MATCH @q
    ORDER BY score
    LIMIT @limit
  `).all({ q, limit });
  return rows;
}

export function iterLogsWithVecMeta(db, { from, to, endpoint, model, region, limit = 2000 } = {}) {
  const rows = db.prepare(`
    SELECT l.*, v.embedding AS emb, v.dim AS dim
    FROM logs_vec v
    JOIN logs_raw l ON l.id = v.id
    WHERE 1=1
      ${from ? 'AND l.ts >= @from' : ''}
      ${to ? 'AND l.ts <= @to' : ''}
      ${endpoint ? 'AND l.endpoint = @endpoint' : ''}
      ${model ? 'AND l.model = @model' : ''}
      ${region ? 'AND l.region = @region' : ''}
    ORDER BY l.ts DESC
    LIMIT @limit
  `).all({ from, to, endpoint, model, region, limit });
  return rows.map(r => {
    const buf = r.emb; // Buffer
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return { ...r, emb: f32 };
  });
}
