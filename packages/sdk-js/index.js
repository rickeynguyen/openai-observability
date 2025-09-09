// Minimal JS SDK for posting traces to the observability server
// ESM module

/**
 * Create a client that posts trace objects to /ingest/trace
 * @param {Object} options
 * @param {string} options.baseUrl - Base URL of the observability server (e.g., http://localhost:3000)
 * @param {string} [options.apiKey] - Optional INGEST_API_KEY for auth
 * @param {Function} [options.fetchImpl] - Optional fetch implementation (defaults to globalThis.fetch)
 */
export function createIngestClient({ baseUrl, apiKey, fetchImpl } = {}) {
  if (!baseUrl) throw new Error('baseUrl required');
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  if (!f) throw new Error('No fetch implementation available');
  const url = baseUrl.replace(/\/$/, '') + '/ingest/trace';
  return {
    async recordTrace(trace) {
      const body = JSON.stringify(trace || {});
      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers['x-api-key'] = apiKey;
      const res = await f(url, { method: 'POST', headers, body });
      if (!res.ok) {
        const txt = await safeText(res);
        throw new Error(`ingest failed ${res.status}: ${txt}`);
      }
      return true;
    }
  };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ''; }
}

/**
 * Wrap an async function, measure latency and emit a trace via the client.
 * @param {Function} fn - async function to execute
 * @param {Object} meta - { endpoint, model, region }
 * @param {Object} client - result of createIngestClient
 * @param {Function} [usageExtractor] - function(result) => { tokensPrompt, tokensCompletion, tokensTotal }
 */
export async function wrapCall(fn, meta, client, usageExtractor) {
  const start = Date.now();
  let ok = true;
  let status = undefined;
  let errType = undefined;
  let result;
  try {
    result = await fn();
  } catch (e) {
    ok = false;
    errType = e?.name || 'Error';
    status = e?.status || e?.code || undefined;
  }
  const latencyMs = Date.now() - start;
  let tokensPrompt, tokensCompletion, tokensTotal;
  try {
    if (usageExtractor && result != null) {
      const u = usageExtractor(result) || {};
      tokensPrompt = normInt(u.tokensPrompt);
      tokensCompletion = normInt(u.tokensCompletion);
      tokensTotal = normInt(u.tokensTotal);
    } else if (result && result.usage) {
      // Common OpenAI-like usage shape
      tokensPrompt = normInt(result.usage.prompt_tokens);
      tokensCompletion = normInt(result.usage.completion_tokens);
      tokensTotal = normInt(result.usage.total_tokens);
    }
  } catch { /* ignore extractor errors */ }
  const respBytes = safeSize(result);
  const trace = {
    ts: Date.now(),
    endpoint: meta?.endpoint || 'unknown',
    model: meta?.model,
    region: meta?.region,
    ok,
    status: typeof status === 'number' ? status : undefined,
    errType,
    latencyMs,
    tokensPrompt,
    tokensCompletion,
    tokensTotal,
    respBytes,
  };
  if (client && typeof client.recordTrace === 'function') {
    try { await client.recordTrace(trace); } catch { /* swallow ingest errors */ }
  }
  return { ok, result, error: ok ? undefined : new Error(errType || 'Error'), trace };
}

function normInt(x) {
  const n = Number(x);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

function safeSize(obj) {
  try {
    const s = JSON.stringify(obj);
    return s ? s.length : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Helpers to extract usage from common OpenAI responses
 */
export const Extractors = {
  chat(resp) {
    const u = resp?.usage || {};
    return {
      tokensPrompt: normInt(u.prompt_tokens),
      tokensCompletion: normInt(u.completion_tokens),
      tokensTotal: normInt(u.total_tokens),
    };
  },
  embeddings(resp) {
    const u = resp?.usage || {};
    return { tokensPrompt: normInt(u.prompt_tokens), tokensTotal: normInt(u.total_tokens) };
  },
  moderations(resp) {
    const u = resp?.usage || {};
    return { tokensPrompt: normInt(u.prompt_tokens), tokensTotal: normInt(u.total_tokens) };
  }
};
