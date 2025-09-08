import percentile from 'percentile';

/**
 * In-memory metrics/time-series store with a ring buffer.
 * Points shape: { ts, ok, status, latencyMs, endpoint, model, region, errType }
 */
export class MetricsStore {
  constructor({ capacity = 1000 } = {}) {
    this.capacity = capacity;
    this.points = [];
  }

  push(point) {
    if (!point || typeof point !== 'object') return;
    if (this.points.length >= this.capacity) this.points.shift();
    this.points.push(point);
  }

  /**
   * Produce summary over last `windowMinutes` minutes OR absolute [from,to] range if provided.
   * from/to take precedence when both supplied (epoch ms).
   */
  summary({ windowMinutes = 60, endpointFilter, from, to } = {}) {
    const now = Date.now();
    let pts;
    let cutoff;
    let rangeFrom = from;
    let rangeTo = to;
    if (from && to) {
      cutoff = from; // for response metadata
      pts = this.points.filter(p => p.ts >= from && p.ts <= to && (!endpointFilter || p.endpoint === endpointFilter));
    } else {
      cutoff = now - windowMinutes * 60 * 1000;
      pts = this.points.filter(p => p.ts >= cutoff && (!endpointFilter || p.endpoint === endpointFilter));
      rangeFrom = cutoff;
      rangeTo = now;
    }
    const byEndpoint = {};
    for (const p of pts) {
      (byEndpoint[p.endpoint] ||= []).push(p);
    }
    const out = {};
    for (const ep of Object.keys(byEndpoint).sort()) {
      const arr = byEndpoint[ep];
      const total = arr.length;
      const okArr = arr.filter(p => p.ok);
      const ok = okArr.length;
      const successRate = total ? ok / total : null;
      const latencies = okArr.map(p => p.latencyMs);
      const p50 = latencies.length ? percentile(50, latencies) : null;
      const p95 = latencies.length ? percentile(95, latencies) : null;
      const p99 = latencies.length ? percentile(99, latencies) : null;
      const errors = arr.filter(p => !p.ok);
      const errCounts = errors.reduce((acc, p) => {
        const key = p.errType || p.status || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      out[ep] = {
        total,
        ok,
        successRate,
        latencyMs: { p50, p95, p99 },
        errors: errCounts,
        sample: arr.slice(-5)
      };
    }
    const windowMinutesEffective = from && to ? Math.ceil((rangeTo - rangeFrom) / 60000) : windowMinutes;
    return {
      since: new Date(rangeFrom).toISOString(),
      now: new Date(rangeTo).toISOString(),
      windowMinutes: windowMinutesEffective,
      endpoints: out,
      range: from && to ? { from: new Date(rangeFrom).toISOString(), to: new Date(rangeTo).toISOString() } : undefined
    };
  }
}
