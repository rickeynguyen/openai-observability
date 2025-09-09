# Lightweight OpenTelemetry Status Backend (No Grafana)

A single-process service that probes key OpenAI API endpoints on a schedule and exposes simple health metrics via `/status` and a minimal dashboard at `/`. Uses the OpenTelemetry SDK in-process (no Collector) and an in-memory store for SLIs.

## Quick start
```bash
cp .env.example .env
# edit OPENAI_API_KEY and (optionally) OPENAI_MODEL/PROBE_INTERVAL_SEC/PROBE_ENDPOINTS
npm install
npm run dev
# open http://localhost:3000
```

## What it does
- Every PROBE_INTERVAL_SEC seconds, probes one or more OpenAI endpoints (round-robin by default) with tiny requests.
- Records success/HTTP status, latency, errType (timeout/network), and labels (endpoint, model, region). Also captures token usage (when available) and response bytes.
- Aggregates last 60 minutes into success rate and p50/p95/p99 latency per endpoint.
- Serves JSON at `/status` and a minimal HTML at `/` (with a time range selector 15m–24h).

## Environment
- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (default `gpt-4o-mini`)
- `PROBE_REGION` (label only, default `us-west-1`)
- `PROBE_INTERVAL_SEC` (default 60)
- `HTTP_TIMEOUT_MS` (default 12000)
- `DB_FILE` (optional path for sqlite file, default `data.db` in project root)
 - `ENABLE_DB` (enable persistence when set to `1` or `true`)
 - `PROBE_ENDPOINTS` (optional, comma-separated list of probes to run; defaults to safe set)
 - `PROBE_MODE` (optional: `roundrobin` [default] runs one endpoint per tick, or `all` runs all selected endpoints per tick)
 - `PROBE_HEAVY` (optional: `1` to include heavy probes like images generation)
 - `OPENAI_EMBEDDINGS_MODEL` (optional override for embeddings model; default `text-embedding-3-small`)
 - `OPENAI_MODERATION_MODEL` (optional override for moderation model; default `omni-moderation-latest`)

## API endpoints
- `GET /status?window=60` → JSON summary (change `window` minutes as needed)
- `GET /` → tiny dashboard
- `GET /traces` → raw trace events with filters, pagination (cursor), and exports
- `GET /latency_histogram` → quick histogram for a given endpoint/time window
 - `GET /incidents` → optional incidents list (filtered by `?from`/`?to` epoch ms). Served from `public/incidents.json` if present.
 - `GET /timeseries` → bucketed counts (ok/total) and latency percentiles for a window or absolute range.

## Cost & safety
- Keep intervals modest (e.g., 60–180s). Most probes are tiny and deterministic.
- Heavy probes (images) are opt-in via `PROBE_HEAVY=1`. Use sparingly.
- Use a dedicated low-limit key for monitoring; set OpenAI budget alerts.

## Extending
- Add another probe by extending `src/probe.js` `_getProbeDefs()` with a new entry.
- Persist via SQLite if you need history beyond the ring buffer.
- For full OTel export later, add OTLP exporter + Collector.

## Included probes (keys)
Defaults (safe, low-cost):
- `chat` → POST /v1/chat/completions (tiny max_tokens)
- `responses` → POST /v1/responses (tiny input)
- `embeddings` → POST /v1/embeddings (short input)
- `moderations` → POST /v1/moderations
- `models` → GET /v1/models
- `files` → GET /v1/files
- `fine_tunes` → GET /v1/fine_tuning/jobs
- `batches` → GET /v1/batches
- `assistants` → GET /v1/assistants

Optional heavy (requires `PROBE_HEAVY=1`):
- `images` → POST /v1/images/generations (small 256x256 prompt)

Configure a subset via `PROBE_ENDPOINTS`, e.g. `PROBE_ENDPOINTS=chat,embeddings,models`.

## Persistence
Set `ENABLE_DB=1` to turn on SQLite persistence (via better-sqlite3). Data stored in `data.db` (override with `DB_FILE`). `/status` queries rows for the selected window and computes percentiles in-process. If disabled, service falls back to in-memory ring buffer only.

## Fly Deploy (manual first time)
```bash
fly auth login
fly launch --no-deploy --dockerfile Dockerfile
fly secrets set OPENAI_API_KEY=sk-...  # set once
fly deploy
fly open
```

## CI
Pushes to `main` trigger GitHub Actions deploying with `flyctl`. Provide repo secret `FLY_API_TOKEN` (and optionally `OPENAI_API_KEY`).

## Testing
Run `npm test` (Node built-in test runner) for store + status endpoint tests.

## UI enhancements (dashboard)
- SLO widgets: current SLI (success rate), error budget remaining bar, and burn-rate sparkline.
- Incident overlays: shaded windows on latency chart from `/incidents` or `public/incidents.json`.
- Compare view: group by model or region; baseline/canary toggles.
- Heatmaps: latency percentiles and error breakdowns.
- Cost panel: stacked tokens and approximate cumulative cost line with simple pricing heuristics.

To provide incidents, either use the bundled `/incidents` endpoint (it reads `public/incidents.json`) or edit `public/incidents.json` with entries like:

[
	{ "id": "INC-1", "start": 1710001000000, "end": 1710001600000, "severity": "high", "title": "Example outage" }
]


## Ingestion (Phase M2)

Endpoint:
- `POST /ingest/trace` — accepts a normalized trace JSON and stores it in memory (and SQLite when enabled). Body must include: `ts` (epoch ms), `endpoint`, `ok`, `latencyMs`, and optional token fields. See `src/schemas.js` for the minimal schema.

Auth:
- Set `INGEST_API_KEY=your-secret` to require a key. Clients send `x-api-key: your-secret` or `Authorization: Bearer your-secret`.

SDKs:
- A minimal JS helper will be provided under `packages/common` (pricing, schema, utils) and a future `packages/sdk-js` wrapper to instrument OpenAI calls and POST traces to `/ingest/trace`.

## AI-centric observability (logs + search + embeddings)

Flags:
- ENABLE_AI=1, ENABLE_DB=1, OPENAI_API_KEY, EMBEDDING_MODEL=text-embedding-3-small (default)
- LOG_SIM_ENABLED=1 (optional), LOG_SIM_INTERVAL_MS=30000
 - INGEST_API_KEY=secret (UI default). Change if you want a different key; enter it in the Chat tab.
 - EMB_INDEX_INTERVAL_MS=45000 (auto-index tick)

Endpoints:
- POST /logs/ingest (NDJSON or JSON array, requires INGEST_API_KEY)
- GET /logs/sim/start, /logs/sim/stop (requires INGEST_API_KEY)
- POST /ai/index/logs?limit=32&since=epoch_ms (embeds pending logs)
- GET /logs/search?query=...&from=&to=&endpoint=&model=&region=&k=20 (hybrid vec+FTS)
- GET /ai/metrics, GET /ai/summary (helpers that reuse /timeseries)

Chat (beta):
- UI: Click the "Chat" tab in the dashboard.
- Backend: POST /ai/chat — returns a concise, LLM-free summary by default. If you enable "Use LLM" in the UI (or send `{ llm: true }`) and set `OPENAI_API_KEY`, it will call the OpenAI Responses API to enhance the summary.
- Streaming: POST /ai/chat/stream — emits NDJSON lines with `{ delta }` chunks and a final `{ done, citations }`. The UI uses this by default and falls back to /ai/chat.
- Controls: Start/Stop the log simulator and "Index embeddings" from the Chat tab. Provide `INGEST_API_KEY` (stored locally) to access protected ops.

Quick start for Chat tab:
1. Set `ENABLE_DB=1`, `ENABLE_AI=1`, `INGEST_API_KEY=your-secret`. Optionally set `OPENAI_API_KEY` for embeddings and LLM enhancement.
2. Start the server, open the dashboard, switch to Chat, enter your ingest key, Start simulator, optionally Index embeddings, and ask a question.
3. Toggle "Use LLM" in the Chat tab to get an enhanced summary (requires `OPENAI_API_KEY`).

Notes:
- If `LOG_SIM_ENABLED=1`, the server auto-starts the simulator. The Chat tab shows a subtle notice so the Start/Stop button state makes sense. Use Stop to pause the timer for this session; on restart it will auto-start again unless you set `LOG_SIM_ENABLED=0`.
- The UI defaults the ingest key to `secret`. Set `INGEST_API_KEY=secret` (or change both sides) to avoid 401s when controlling the simulator or indexer.

Misc:
- `GET /config` returns non-sensitive runtime flags (ai/db enabled, sim/index intervals) for the UI.

## Synthetic Monitors (beta)

Create browser-like synthetic tests using the dashboard with AI assistance.

UI:
- Click "Create Synthetic" in the top menu.
- Describe your test (e.g., "visit https://chatgpt.com, type 'tell me a joke' in the input, press Enter, pass if a response appears").
- Click Draft with AI to generate a JSON spec; review/edit.
- Click Create Monitor, then Run Now to execute (tries Playwright, falls back to HTTP fetch).

Endpoints:
- POST `/synthetics/draft` { prompt } → { spec }
- POST `/synthetics` { spec } → { id, monitor }
- GET `/synthetics` → { items }
- POST `/synthetics/:id/run` → { ok, statusText, screenshot?, logs[] }
- GET `/synthetics/runs` → recent runs

Notes:
- Playwright is optional. If not installed, the run falls back to a simple HTTP GET + text assert.
- Screenshots (when available) are saved under `public/synth/` and shown in the modal.

