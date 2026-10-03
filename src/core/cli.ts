#!/usr/bin/env node
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { EvalladderConfig } from './config.js';
import type { EvalReport } from './types.js';
import { ProviderRegistry } from './ProviderRegistry.js';
import { DefaultEvalRunner } from './runner.js';
import { releaseGate } from './ReleaseGate.js';
import { toMarkdown } from './report.js';

const USAGE = `Usage: evalladder run --config <file.mjs> [--out report.json] [--baseline prev-report.json] [--threshold 0.8] [--only id1,id2]`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'run') {
    console.log(USAGE);
    process.exit(cmd ? 2 : 0);
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: 'string', default: 'evalladder.config.mjs' },
      out: { type: 'string' },
      baseline: { type: 'string' },
      threshold: { type: 'string' },
      only: { type: 'string' },
    },
  });
  const mod = await import(pathToFileURL(resolve(values.config!)).href);
  const cfg: EvalladderConfig = mod.default ?? mod.config;
  const suite = { ...cfg.suite };
  if (values.only) {
    const ids = new Set(values.only.split(','));
    suite.targets = suite.targets.filter((t) => ids.has(t.id));
  }
  const registry = new ProviderRegistry().use(...cfg.plugins);
  const report = await new DefaultEvalRunner(registry, {
    onResult: (r) => console.error(`${r.grade.pass ? 'PASS' : 'FAIL'} ${r.productId} ${r.caseId}${r.error ? ` (error: ${r.error})` : ''}`),
  }).run(suite);
  const baseline: EvalReport | undefined = values.baseline
    ? JSON.parse(await readFile(values.baseline, 'utf8').catch(() => 'null')) ?? undefined
    : undefined;
  const gate = releaseGate(report, {
    ...cfg.gate,
    threshold: values.threshold ? Number(values.threshold) : (cfg.gate?.threshold ?? suite.passThreshold),
    baseline,
  });
  const md = toMarkdown(report, gate);
  console.log(md);
  if (values.out) await writeFile(values.out, JSON.stringify({ ...report, gate }, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  process.exit(gate.pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
