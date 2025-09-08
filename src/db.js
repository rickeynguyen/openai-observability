import Database from 'better-sqlite3';
import path from 'node:path';

export function openDb() {
  const file = process.env.DB_FILE || path.join(process.cwd(), 'data.db');
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
