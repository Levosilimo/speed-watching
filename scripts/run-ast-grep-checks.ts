#!/usr/bin/env bun
/**
 * run-ast-grep-checks — runs ast-grep proximity rules against source files.
 *
 * Invokes `ast-grep scan --rule scripts/check-restatement-comments.yml src/ scripts/`.
 * Falls back gracefully if ast-grep is not installed (exits 0 with INFO message).
 * Exits non-zero only when LCE_STRICT_AST_GREP=1 AND findings exist.
 *
 * Bypass marker: any comment containing "lce-allow-restating-comment" is skipped by the rules.
 *
 * Install ast-grep: bun add -D @ast-grep/cli
 */
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { loadLceIgnore } from "./load-lce-ignore.js"

const SCRIPT_DIR = import.meta.dirname
const RULE_FILE = resolve(SCRIPT_DIR, "check-restatement-comments.yml")
const PROJECT_DIR = resolve(SCRIPT_DIR, "..")

function checkAstGrepAvailable(): boolean {
  try {
    const result = spawnSync("ast-grep", ["--version"], {
      stdio: "pipe",
      timeout: 10_000,
    })
    return result.status === 0
  } catch {
    return false
  }
}

function runAstGrepScan(): { findings: number; stdout: string } | null {
  const { globs: ignoreGlobs } = loadLceIgnore(PROJECT_DIR)
  const ignoreArgs = ignoreGlobs.flatMap((g) => ["--ignore", g])

  const result = spawnSync(
    "ast-grep",
    [
      "scan",
      "--rule",
      RULE_FILE,
      ...ignoreArgs,
      resolve(PROJECT_DIR, "src"),
      resolve(PROJECT_DIR, "scripts"),
    ],
    {
      stdio: "pipe",
      timeout: 60_000,
    },
  )

  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()

  // ast-grep exits 0 even with findings; parse output for match count
  const matchLines =
    stdout.split("\n").filter((l: string) => l.includes("match:") || l.includes("matches:"))
      .length || stdout.split("---").length - 1

  return { findings: Math.max(0, matchLines - 1), stdout: stdout + stderr }
}

function main(): void {
  if (!checkAstGrepAvailable()) {
    console.log("[INFO] ast-grep not installed; skipping proximity check.")
    console.log("[INFO] Install: bun add -D @ast-grep/cli")
    process.exit(0)
  }

  if (!existsSync(RULE_FILE)) {
    console.log(`[WARN] Rule file not found: ${RULE_FILE}`)
    process.exit(0)
  }

  const result = runAstGrepScan()
  if (!result) {
    console.log("[INFO] ast-grep scan completed with no output")
    process.exit(0)
  }

  if (result.findings > 0) {
    console.log(`[WARN] ast-grep found ${result.findings} potential restatement(s)`)
    console.log(result.stdout)

    if (process.env.LCE_STRICT_AST_GREP === "1") {
      console.error(`[FAIL] LCE_STRICT_AST_GREP=1: ${result.findings} finding(s) must be resolved`)
      process.exit(1)
    }
    console.log("[INFO] Findings are advisory. Set LCE_STRICT_AST_GREP=1 to fail on findings.")
  } else {
    console.log("[INFO] ast-grep: no restatement patterns detected")
  }

  process.exit(0)
}

main()
