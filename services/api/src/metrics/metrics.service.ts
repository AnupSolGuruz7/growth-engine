import { Injectable } from '@nestjs/common';

const LATENCY_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];

/** Minimal in-process Prometheus-style counters for ingestion (spec §5.4 observability). */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly buckets = new Array(LATENCY_BUCKETS_MS.length + 1).fill(0) as number[];
  private latencySum = 0;
  private latencyCount = 0;

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    if (by <= 0) return;
    const key = `${name}${fmtLabels(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observeLatency(ms: number): void {
    this.latencySum += ms;
    this.latencyCount++;
    const i = LATENCY_BUCKETS_MS.findIndex((b) => ms <= b);
    this.buckets[i === -1 ? LATENCY_BUCKETS_MS.length : i]!++;
  }

  render(gauges: Record<string, number>): string {
    const lines: string[] = [];
    for (const [k, v] of [...this.counters.entries()].sort()) lines.push(`${k} ${v}`);
    let cumulative = 0;
    LATENCY_BUCKETS_MS.forEach((b, i) => {
      cumulative += this.buckets[i]!;
      lines.push(`growthos_ingest_latency_ms_bucket{le="${b}"} ${cumulative}`);
    });
    cumulative += this.buckets[LATENCY_BUCKETS_MS.length]!;
    lines.push(`growthos_ingest_latency_ms_bucket{le="+Inf"} ${cumulative}`);
    lines.push(`growthos_ingest_latency_ms_sum ${this.latencySum}`);
    lines.push(`growthos_ingest_latency_ms_count ${this.latencyCount}`);
    for (const [k, v] of Object.entries(gauges)) lines.push(`${k} ${v}`);
    return lines.join('\n') + '\n';
  }
}

function fmtLabels(labels: Record<string, string>): string {
  const e = Object.entries(labels);
  return e.length ? `{${e.map(([k, v]) => `${k}="${v}"`).join(',')}}` : '';
}
