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
