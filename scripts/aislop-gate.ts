#!/usr/bin/env bun
/**
 * aislop-gate — SARIF-based quality gate for aislop scan results.
 *
 * Reads SARIF JSON from stdin (pipe from `bunx aislop scan --staged --format sarif`),
 * exits 0 on clean scan, 1 if any blocking-level result found or the scan
 * produced no output at all, 2 on malformed input.
 *
 * Blocking level: 'error' (default), or 'error|warning' if LCE_STRICT_AISLOP=1.
 * Setting LCE_STRICT_AISLOP=0 disables gating (advisory only).
 *
 * Usage in lefthook.yml:
 *   aislop:
 *     run: bunx aislop scan --staged --format sarif | bun run scripts/aislop-gate.ts
 */

interface SarifLog {
  runs?: Array<{
    results?: Array<{
      level?: string
    }>
  }>
}

function parseSarif(input: string): SarifLog {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new Error("Malformed SARIF: not valid JSON")
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Malformed SARIF: not a JSON object")
  }
  const log = parsed as SarifLog
  if (!Array.isArray(log.runs)) {
    throw new Error("Malformed SARIF: missing runs array")
  }
  return log
}

function blockingLevels(): Set<string> {
  const strict = process.env["LCE_STRICT_AISLOP"]
  if (strict === "0" || strict === "false") return new Set() // advisory-only mode (no gate)
  // Default: error and warning block the commit; notes pass through.
  return new Set(["error", "warning"])
}

function countBlocking(log: SarifLog, levels: Set<string>): number {
  let count = 0
  for (const run of log.runs ?? []) {
    for (const result of run.results ?? []) {
      const lvl = result.level ?? "warning" // SARIF default
      if (levels.has(lvl)) {
        count++
      }
    }
  }
  return count
}

function main(): void {
  const stdin = process.stdin
  let input = ""

  stdin.setEncoding("utf-8")
  stdin.on("data", (chunk: string) => {
    input += chunk
  })

  stdin.on("end", () => {
    if (!input || input.trim() === "") {
      // aislop always emits a SARIF log with an empty results array on a
      // clean scan, so empty stdin means the scan died before writing
      // anything — a missing gate must not pass.
      console.error("[aislop-gate] aislop produced no output (scan crashed or was killed)")
      process.exit(1)
    }
    try {
      const log = parseSarif(input)
      const levels = blockingLevels()
      const blocking = countBlocking(log, levels)
      if (blocking > 0) {
        console.error(
          `[aislop-gate] ${blocking} blocking result(s) (${[...levels].join(",")}) — commit blocked`,
        )
        process.exit(1)
      }
      process.exit(0)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[aislop-gate] ${msg}`)
      process.exit(2)
    }
  })
}

if (import.meta.main) {
  main()
}
