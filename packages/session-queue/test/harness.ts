/**
 * 极简测试框架（零依赖）。
 *
 * 本包是零运行时依赖的 pi 扩展，不引入测试框架；用 bun / tsx 均可直接运行。
 */
export interface TestCase {
  suite: string;
  name: string;
  fn: () => void | Promise<void>;
}

const cases: TestCase[] = [];
let currentSuite = "(未分组)";

export function describe(name: string, fn: () => void): void {
  const prev = currentSuite;
  currentSuite = name;
  fn();
  currentSuite = prev;
}

export function it(name: string, fn: () => void | Promise<void>): void {
  cases.push({ suite: currentSuite, name, fn });
}

export function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(v: unknown): unknown {
  if (v instanceof Map) return { __map: [...v.entries()].map(([k, val]) => [normalize(k), normalize(val)]) };
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = normalize((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

export function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}${msg ? ` — ${msg}` : ""}`);
  }
}

export function ok(value: unknown, msg?: string): void {
  if (!value) throw new Error(`期望真值，实际 ${JSON.stringify(value)}${msg ? ` — ${msg}` : ""}`);
}

export async function runAll(): Promise<number> {
  let pass = 0;
  const failures: { suite: string; name: string; err: unknown }[] = [];
  let lastSuite = "";

  for (const c of cases) {
    if (c.suite !== lastSuite) {
      console.log(`\n${c.suite}`);
      lastSuite = c.suite;
    }
    try {
      await c.fn();
      pass++;
      console.log(`  ✓ ${c.name}`);
    } catch (err) {
      failures.push({ suite: c.suite, name: c.name, err });
      console.log(`  ✗ ${c.name}`);
    }
  }

  console.log(`\n${"─".repeat(60)}`);
  if (failures.length > 0) {
    console.log(`失败 ${failures.length} 项：\n`);
    for (const f of failures) {
      console.log(`  ${f.suite} › ${f.name}`);
      console.log(`    ${(f.err as Error)?.message ?? String(f.err)}\n`);
    }
  }
  console.log(`通过 ${pass} / 共 ${cases.length}`);
  return failures.length;
}
