import type { RunReport, GateDecision } from './types.js';

/** Markdown table for PR comments / GitHub step summary. */
export function toMarkdown(report: RunReport, gate?: GateDecision): string {
  const lines = [
    `### Eval: ${report.suiteId} (prompt ${report.promptId})`,
    '',
    '| Model | Provider | Pass rate | Passed | Failed | Errored | Model $ | Check $ | Avg latency | Gate |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const m of report.models) {
    const g = gate?.models.find((x) => x.productId === m.productId);
    lines.push(
      `| ${m.modelId} | ${m.provider} | ${(m.passRate * 100).toFixed(1)}% | ${m.passed} | ${m.failed} | ${m.errored} | ` +
        `$${m.modelCostUsd.toFixed(6)} | $${m.assertionCostUsd.toFixed(6)} | ${m.avgLatencyMs} ms | ${g ? (g.pass ? 'pass' : `FAIL: ${g.reason}`) : '-'} |`,
    );
  }
  lines.push('', `Total cost: $${report.totalCostUsd.toFixed(6)}`);
  if (gate) lines.push(`Release gate: **${gate.pass ? 'PASS' : 'FAIL'}**`);
  return lines.join('\n');
}
