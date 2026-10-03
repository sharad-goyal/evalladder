import type { RunReport, GateDecision } from './types.js';

export interface GateOptions {
  threshold: number;
  /** Previous report or productId -> passRate. A model must not drop below its baseline. */
  baseline?: RunReport | Record<string, number>;
  /** Allowed drop vs baseline (e.g. 0.02). Default 0. */
  tolerance?: number;
}

/** Per model: pass only if passRate >= threshold AND >= baseline - tolerance. Synchronous: returns GateDecision, never throws. */
export function releaseGate(report: RunReport, opts: GateOptions): GateDecision {
  const base = toMap(opts.baseline);
  const tol = opts.tolerance ?? 0;
  const models = report.models.map((m) => {
    const b = base[m.productId];
    const okThreshold = m.passRate >= opts.threshold;
    const okBaseline = b === undefined || m.passRate >= b - tol;
    const reasons: string[] = [];
    if (!okThreshold) reasons.push(`passRate ${pct(m.passRate)} < threshold ${pct(opts.threshold)}`);
    if (!okBaseline) reasons.push(`passRate ${pct(m.passRate)} < baseline ${pct(b!)}`);
    return {
      productId: m.productId,
      passRate: m.passRate,
      threshold: opts.threshold,
      baseline: b,
      pass: okThreshold && okBaseline,
      reason: reasons.join('; ') || 'ok',
    };
  });
  return { pass: models.length > 0 && models.every((m) => m.pass), models };
}

function toMap(b?: RunReport | Record<string, number>): Record<string, number> {
  if (!b) return {};
  if ('models' in b && Array.isArray((b as RunReport).models)) {
    return Object.fromEntries((b as RunReport).models.map((m) => [m.productId, m.passRate]));
  }
  return b as Record<string, number>;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
