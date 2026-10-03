import type { AssertionPlugin, AssertionResult, BuiltinAssertion, ModelOutput, PluginAssertion, Assertion, TestCase } from './types.js';
import { ConfigError } from './errors.js';

export const BUILTIN_TYPES = new Set(['equals', 'contains', 'not-contains', 'regex', 'is-json', 'custom']);

export function isBuiltin(a: Assertion): a is BuiltinAssertion {
  return BUILTIN_TYPES.has(a.type);
}

/**
 * Built-in checks. checkBuiltin(): Promise<AssertionResult>
 *   resolves: always (pass true/false). A custom fn that throws resolves pass:false with the message.
 */
export async function checkBuiltin(a: BuiltinAssertion, output: ModelOutput, tc: TestCase): Promise<AssertionResult> {
  const text = output.text;
  const ci = (s: string, on?: boolean) => (on ? s.toLowerCase() : s);
  switch (a.type) {
    case 'equals': {
      const pass = ci(text.trim(), a.ignoreCase) === ci(a.value.trim(), a.ignoreCase);
      return r(a.type, pass, pass ? 'equals' : `expected "${a.value}"`);
    }
    case 'contains': {
      const pass = ci(text, a.ignoreCase).includes(ci(a.value, a.ignoreCase));
      return r(a.type, pass, pass ? `contains "${a.value}"` : `missing "${a.value}"`);
    }
    case 'not-contains': {
      const pass = !ci(text, a.ignoreCase).includes(ci(a.value, a.ignoreCase));
      return r(a.type, pass, pass ? `does not contain "${a.value}"` : `contains forbidden "${a.value}"`);
    }
    case 'regex': {
      const pass = new RegExp(a.value, a.flags).test(text);
      return r(a.type, pass, pass ? `matches /${a.value}/` : `no match for /${a.value}/`);
    }
    case 'is-json': {
      try {
        JSON.parse(stripFences(text));
        return r(a.type, true, 'valid JSON');
      } catch {
        return r(a.type, false, 'not valid JSON');
      }
    }
    case 'custom': {
      const label = a.name ?? 'custom check';
      try {
        const pass = await a.fn(output, tc);
        return r(a.type, pass, `${label} ${pass ? 'passed' : 'failed'}`);
      } catch (e) {
        return r(a.type, false, `${label} threw: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

function r(type: string, pass: boolean, reason: string): AssertionResult {
  return { type, pass, score: pass ? 1 : 0, reason, costUsd: 0 };
}

export function stripFences(s: string): string {
  const m = s.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s.trim();
}

/** Throws ConfigError if any assertion type has no built-in and no registered plugin. */
export function validateAssertionTypes(cases: TestCase[], plugins: Map<string, AssertionPlugin>): void {
  for (const tc of cases) {
    for (const a of tc.assertions) {
      if (!isBuiltin(a) && !plugins.has(a.type)) {
        throw new ConfigError(
          `Case "${tc.id}" uses assertion type "${a.type}" but no plugin handles it. ` +
            `Built-ins: ${[...BUILTIN_TYPES].join(', ')}. Register a plugin (e.g. judge() from evalladder/judge for "llm-rubric").`,
        );
      }
    }
  }
}

/**
 * Runs a case's assertions in order: built-ins first ($0), plugin checks after, and only if all built-ins passed.
 * Promise<AssertionResult[]>; rejects with InfraError if a plugin check could not run.
 */
export async function runAssertions(tc: TestCase, output: ModelOutput, plugins: Map<string, AssertionPlugin>): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  const builtins = tc.assertions.filter(isBuiltin);
  const others = tc.assertions.filter((a): a is PluginAssertion => !isBuiltin(a));
  for (const a of builtins) results.push(await checkBuiltin(a, output, tc));
  if (results.some((x) => !x.pass)) return results;
  for (const a of others) {
    const res = await plugins.get(a.type)!.check(a, output, tc);
    results.push(res);
    if (!res.pass) break;
  }
  return results;
}
