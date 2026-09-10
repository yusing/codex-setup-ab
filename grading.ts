/** Ignore Go comments and literals before recognizing named test declarations. */
export function acceptanceTestNames(source: string): string[] {
  const declarations = source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`[^`]*`/g, " ");
  return [...declarations.matchAll(/\bfunc\s+(TestABAcceptance[\p{L}\p{Nd}_]*)\s*\(/gu)].map(match => match[1]);
}

/** Package success alone is insufficient: TestMain can exit without running tests. */
export function acceptanceExecutionError(jsonl: string, expectedTests: string[]): string | undefined {
  if (expectedTests.length === 0) return "evaluator declares no TestABAcceptance tests";
  const started = new Set<string>();
  const passed = new Set<string>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let event: { Action?: unknown; Test?: unknown };
    try { event = JSON.parse(line); } catch { return "test output is not valid go test -json evidence"; }
    if (!event || typeof event.Test !== "string") continue;
    if (event.Action === "run") started.add(event.Test);
    if (event.Action === "pass" && started.has(event.Test)) passed.add(event.Test);
    if (event.Action === "skip" || event.Action === "fail") passed.delete(event.Test);
  }
  const missing = expectedTests.filter(name => !passed.has(name));
  return missing.length ? `acceptance tests did not execute and pass: ${missing.join(", ")}` : undefined;
}
