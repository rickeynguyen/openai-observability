# OpenAI Observability & Synthetic Monitoring (All‑in‑one Minimal Stack)

Single-process Node.js service + lightweight HTML UI that gives you:

| Capability | Included | Notes |
|------------|----------|-------|
| API Probes / SLIs | ✅ | Latency & success aggregates, percentiles, multi-endpoint selection |
| Live Stream (SSE) | ✅ | `/events` for near real-time probe points |
| Historical Persistence | ✅ | SQLite (enable with `ENABLE_DB=1`) |
| Log Ingestion & Search (FTS + Embeddings) | ✅ | Set `ENABLE_AI=1`, embeddings optional |
| Embedding Similarity + Hybrid Search | ✅ | Vector store in SQLite (blob) + FTS5 |
| Chat / AI Summaries | ✅ | Local heuristic or OpenAI Responses API when key provided |
| Chat Grounding Evidence | ✅ | Source log snippets surfaced with each answer |
| Direct Metric Intents | ✅ | e.g. "slowest endpoint" returns concise deterministic answer |
| Synthetic Browser Monitors | ✅ | Playwright (screenshots, steps, schedules) |
| Auth (simple key) for ingestion & ops | ✅ | `INGEST_API_KEY` header check |
| Deployment (Docker, Render, Fly) | ✅ | `render.yaml` & `fly.toml` samples |

Minimal dependencies, no collector, no Grafana. Ideal for a small team or personal infra sanity dashboard.

---
## Quick Start (Local)
```bash
cp .env .env.local 2>/dev/null || cp .env.example .env   # ensure you have a working file
edit .env                                                # set OPENAI_API_KEY (low quota key recommended)
npm install
npm run dev
# open http://localhost:3000
```

### Docker (local)
```bash
docker build -t openai-observability .
docker run --rm -p 3000:3000 --env-file .env openai-observability
```

### Render (recommended for quick hosted trial)
1. Ensure `render.yaml` is committed (already in repo).
2. Create a new Blueprint in Render, connect repo.
3. Add disks: 1GB persistent at `/data`.
4. Set secrets (`OPENAI_API_KEY`, `INGEST_API_KEY`), leave non-secret env vars in YAML.
5. Deploy, open `/healthz` → should return `{ ok: true }`.

### Fly (legacy optional)
> Fly’s free tier model changes; use Render unless you already use Fly.
```bash
fly auth login
fly launch --no-deploy --dockerfile Dockerfile
fly volumes create data --size 1 --region sjc
fly secrets set OPENAI_API_KEY=sk-... INGEST_API_KEY=your-ingest
fly deploy
```

---
## How It Works
1. Periodic probes hit selected OpenAI endpoints using tiny requests.
2. Each point (ts, ok, latency, status, tokens, endpoint, model, region) stored in ring buffer and optionally SQLite.
3. The UI renders recent SLIs, percentiles, histograms and traces with filtering.
4. Optional AI mode ingests arbitrary logs (manual or simulated) → FTS + embeddings → semantic / lexical search + chat summarization.
5. Synthetic monitors run Playwright scripts generated or edited via a simple DSL with per-step timing & screenshots.

---
## Environment Variables
Secrets (set via your platform’s secret manager; DO NOT commit real keys):
- `OPENAI_API_KEY` – Needed for: embeddings indexing, AI summaries with LLM, synthetic draft, vector embedding.
- `INGEST_API_KEY` – Gate for `/logs/*` ops and auto-index controls (client sends `x-api-key`).

Core (safe to put in config files):
- `OPENAI_MODEL` (default `gpt-4o-mini` or project override) – probe model.
- `OPENAI_RESPONSES_MODEL` – model for Responses API (chat tab) fallback logic.
- `OPENAI_EMBEDDINGS_MODEL` (default `text-embedding-3-small`).
- `PROBE_INTERVAL_SEC` (e.g. 60–1800) – cadence per tick.
- `PROBE_MODE` (`roundrobin` | `all`).
- `PROBE_REGION` – label only.
- `HTTP_TIMEOUT_MS` – timeout for probe HTTP calls.
- `ENABLE_DB` (`1`) – enable SQLite persistence.
- `DB_FILE` – path (e.g. `/data/data.db`).
- `ENABLE_AI` – enable logs + embeddings + chat features.
- `LOG_SIM_ENABLED` – auto-start log simulator.
- `LOG_SIM_INTERVAL_MS` – simulator batch interval.
- `EMB_INDEX_INTERVAL_MS` – auto embedding index tick.
- `PROBE_ENDPOINTS` – comma list override (else default safe set).
- `PROBE_HEAVY=1` – include optionally expensive probes (images, etc.).

Other:
- `INGEST_API_KEY` (dup reminder) – UI defaults to `secret`; change both sides.

Health:
- `/healthz` returns `{ ok: true }` when server is up.

Security Tips:
- Use a low-quota, isolated OpenAI key.
- Rotate immediately if a key ever lands in git history.
- Consider setting a stricter `PROBE_INTERVAL_SEC` (e.g. 300) to cap cost.

---
## Probes & Metrics
- Endpoints: chat, responses, embeddings, moderations, models, files, fine_tunes, batches, assistants (+ images with `PROBE_HEAVY`).
- Metrics: success rate (SLI), latency p50/p95/p99, raw recent events.
- JSON: `GET /status?window=60` (minutes), streaming events via `GET /events`.
- Timeseries / histograms: `GET /latency_histogram`, `GET /timeseries`.
- Incidents overlay (optional): supply `public/incidents.json` → `GET /incidents`.

---
## Logs & AI (Observability Mode)
Prerequisites: `ENABLE_DB=1`, `ENABLE_AI=1`, `OPENAI_API_KEY`, `INGEST_API_KEY`.

Endpoints:
- `POST /logs/ingest` (NDJSON or JSON array) – requires `x-api-key`.
- Simulator: `GET /logs/sim/start`, `/logs/sim/stop`, `/logs/sim/status`.
- Hybrid search: `GET /logs/search?query=...` (FTS + (future) vector scoring).
- Embeddings index: `POST /ai/index/logs` (manual) or auto-indexer: `.../auto/start|stop|status`.
- Chat summarization: `POST /ai/chat` (JSON) or streaming `POST /ai/chat/stream`.

Chat UI usage:
1. Open “Chat” tab, enter ingest key (matches `INGEST_API_KEY`).
2. Optionally start simulator & auto-index.
3. Toggle “Use LLM” to include model-based enhancement; off = local summarizer only.

### Grounding / Evidence (RAG Transparency)
Every chat answer now includes an evidence panel listing up to 10 log snippets (FTS/vector ranked; falls back to recent probe points when DB disabled). Each snippet shows timestamp, status, endpoint, model & region plus the original log text (truncated to 400 chars). Copy buttons let you inspect or export raw context. This:
- Boosts trust (auditable sources → reduced hallucination risk)
- Makes it easy to pivot from narrative → specific raw events
- Works in both standard and streaming modes (stream emits evidence on final line)

Disable (if desired) by hiding the UI container (`#chatEvidence`) or filtering evidence client-side; server response is additive/backwards compatible.

### Direct Metric Intents (Smart Shortcuts)
Certain plain-English questions short‑circuit the generic reliability summary and produce a precise, deterministic answer (and skip LLM even if enabled) for speed and clarity.

Currently implemented:

| Intent | Sample Phrases | Output Style |
|--------|----------------|--------------|
| Slowest Endpoint | `which is the slowest endpoint?`, `slowest endpoint please`, `what's the slowest endpoint` | `Slowest endpoint (by p95) is /v1/files (p95 1487 ms, p99 1510 ms, samples 42). Next: /v1/chat/completions (p95 910 ms).` |

Behavior notes:
- Ranks by p95 latency (ties broken by p99 then p50) over successful calls in the selected time window.
- Prefers endpoints with ≥2 samples; falls back to single-sample if necessary.
- Streams token-by-token (streaming endpoint) but still emits full structured `summary`, `data`, and `evidence` objects for charts and grounding.
- LLM use is suppressed for these intents to avoid verbose paraphrasing.

Planned (open an issue to prioritize): top errors, highest error-rate endpoint, most used model (already partially handled), peak token usage, rate limiting hotspots.

---
## Synthetic Browser Monitors
Create / edit synthetic tests inline or draft via LLM.

Spec DSL (excerpt):
```json
{
	"name": "Homepage",
	"schedule": "every_5m",
	"startUrl": "https://example.com",
	"steps": [
		{ "action": "goto", "url": "https://example.com" },
		{ "action": "type", "selector": "input[name=q]", "text": "hello", "enter": true },
		{ "action": "assertTextContains", "selector": "body", "text": "hello", "any": true }
	]
}
```

Actions: `goto | click | type | waitFor | assertTextContains` (+ timing & retry fields: `timeoutMs`, `retryMs`, `pollMs`, `soft`). Step IDs are auto-assigned & preserved across edits.

Endpoints:
- `POST /synthetics/draft` – LLM spec generation.
- `POST /synthetics` – create monitor.
- `GET /synthetics` – list.
- `POST /synthetics/:id/run` – manual run now.
- `PATCH /synthetics/:id/schedule` – schedule change (immediate run on change if interval > 0).
- Step-level CRUD: `POST /synthetics/:id/steps`, `DELETE /synthetics/:id/steps/:stepId`, `PUT /synthetics/:id/steps`, `POST /synthetics/:id/steps/reorder`.
- Runs listing: `GET /synthetics/runs`, details: `GET /synthetics/runs/:id`.

Playwright is used if available; otherwise falls back to a simple HTTP GET + basic assertion.

Persistence: with `ENABLE_DB=1` monitors & runs survive restarts (SQLite). Screenshots stored under `public/synth/`.

---
## API Summary (Selected)
| Method | Path | Purpose |
|--------|------|---------|
| GET | /status | SLI summary window |
| GET | /events | SSE stream of points |
| GET | /traces | Raw probe events (filters) |
| GET | /latency_histogram | Per-endpoint histogram |
| GET | /timeseries | Bucketed latency + ok/total |
| POST | /logs/ingest | Ingest logs (auth) |
| GET | /logs/sim/start | Start simulator (auth) |
| GET | /ai/index/auto/start | Start auto indexing (auth) |
| POST | /ai/chat | Summary / optional LLM |
| POST | /synthetics | Create monitor |
| POST | /synthetics/:id/run | Run synthetic now |
| GET | /synthetics/runs | Recent synthetic runs |
| GET | /healthz | Health check |

---
## Deployment (Details)

### Render (Blueprint)
Uses `render.yaml` (Docker runtime). Adjust plan size & region; add disk at `/data` for persistence.

### Fly
If you opt to keep Fly, ensure volume and secrets as documented above; Playwright base image is large (~1.6GB) first pull.

### Custom Docker / k8s
Expose port 3000 → service; mount a persistent path for `DB_FILE`. Set secrets as environment variables in your orchestrator.

---
## Testing
```bash
npm test
```
Uses Node built-in test runner for core logic (extend as needed).

---
## Extending
- Add probe: modify `_getProbeDefs()` in `src/probe.js`.
- New synthetic action: extend runner switch in `runSyntheticMonitor`.
- Additional log enrichment: adjust insertion logic in `insertLogs` (db.js).
- Export traces externally: wire an OTLP exporter in `initOTel()`.

---
## Cost & Safety
- Keep `PROBE_INTERVAL_SEC` higher in production (e.g., 300) unless you need fine granularity.
- Avoid enabling heavy probes unless necessary.
- Simulator is synthetic; disable in production (`LOG_SIM_ENABLED=0`).
- Chat LLM mode only consumes tokens when you enable it.

---
## Security / Hardening Ideas
- Reverse proxy & basic auth for UI.
- Rate limit ingestion endpoints.
- Run as non-root user in a slimmer multi-stage image if desired.
- Consider read-only filesystem (except mounted `/data`).

---
## License
GPL-3.0 (see `LICENSE`). Contributions welcome – please open an issue or PR. By submitting a contribution you agree to license your work under the same license. If you intended a more permissive license (e.g. MIT) open an issue to discuss before large changes.

---
## At a Glance
| Need | Variable(s) | Minimal Example |
|------|-------------|-----------------|
| Basic probes | OPENAI_API_KEY | key + defaults |
| Persistence | ENABLE_DB=1, DB_FILE | /data/data.db |
| AI Logs/Search | ENABLE_AI=1 + above | + INGEST_API_KEY + embeddings model |
| Synthetics | (Playwright in image) | Already in Dockerfile |
| Auto Index | EMB_INDEX_INTERVAL_MS | 45000 |

---
Happy hacking ✨

