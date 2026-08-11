#!/usr/bin/env bun
/**
 * load-lce-ignore — Load .lceignore patterns and provide utility functions.
 *
 * Provides default generated-file patterns and the ability to load
 * additional patterns from a project's .lceignore file (gitignore-style).
 *
 * Usage:
 *   import { loadLceIgnore, shouldIgnore } from "./load-lce-ignore"
 *   const { globs } = loadLceIgnore()
 *   if (shouldIgnore("path/to/file.gen.ts", globs)) { ... }
 */
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

export const GENERATED_FILE_PATTERNS: string[] = [
  "**/worker-configuration.d.ts",
  "**/*.gen.*",
  "**/*.d.ts",
  "**/generated/**",
  "**/__generated__/**",
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".pnpm/",
  ".venv/",
  "__pycache__/",
  "target/",
  "vendor/",
]

export interface LceIgnoreResult {
  globs: string[]
  negations: string[]
  source: "default" | ".lceignore" | "both"
}

/**
 * Load .lceignore patterns from the project root.
 * Returns the combined list of default patterns and .lceignore patterns.
 *
 * @param rootDir - Optional root directory to search from. Defaults to project root.
 * @returns Object containing globs array and source description.
 */
export function loadLceIgnore(rootDir?: string): LceIgnoreResult {
  const baseDir = rootDir ?? resolve(import.meta.dirname ?? process.cwd(), "..")
  const defaultGlobs = [...GENERATED_FILE_PATTERNS]
  const lceignorePath = resolve(baseDir, ".lceignore")

  const negations: string[] = []

  if (existsSync(lceignorePath)) {
    const content = readFileSync(lceignorePath, "utf-8")
    const customGlobs: string[] = []
    for (const line of content.split("\n")) {
      const trimmed = line.trim()
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) continue
      // Negation: !pattern means force-include
      if (trimmed.startsWith("!")) {
        negations.push(trimmed.slice(1))
      } else {
        customGlobs.push(trimmed)
      }
    }
    if (customGlobs.length > 0 || negations.length > 0) {
      return {
        globs: [...defaultGlobs, ...customGlobs],
        negations,
        source: "both",
      }
    }
  }

  return {
    globs: defaultGlobs,
    negations,
    source: defaultGlobs.length > 0 ? "default" : ".lceignore",
  }
}

/**
 * Convert a .gitignore-style glob pattern to a RegExp.
 *
 * Supports:
 *   - ** matches any number of directories
 *   - * matches within a single path segment
 *   - Trailing / matches directory prefix
 *   - Literal text matches itself
 */
function globToRegex(pattern: string): RegExp {
  // Trailing / means match any path starting with this directory
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1)
    return new RegExp(`^(?:.+/|)${escapeGlob(dir)}(?:/|$)`) // nosemgrep: detect-non-literal-regexp — patterns come from hardcoded GENERATED_FILE_PATTERNS or .lceignore (developer-controlled, not user input)
  }

  let src = ""
  let i = 0
  const len = pattern.length

  while (i < len) {
    const ch = pattern[i] ?? ""

    if (ch === "*" && i + 1 < len && pattern[i + 1] === "*") {
      // ** — match everything or nothing, including path separators
      if (i + 2 < len && pattern[i + 2] === "/") {
        // **/ — matches any directory prefix
        src += "(?:.+/)?"
        i += 3
      } else {
        // ** at end — matches everything
        src += ".*"
        i += 2
      }
    } else if (ch === "*") {
      // Single * — match within one path segment (no /)
      src += "[^/]*"
      i++
    } else if (ch === ".") {
      src += "\\."
      i++
    } else if (ch === "?") {
      src += "[^/]"
      i++
    } else {
      // Escape special regex chars
      src += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch
      i++
    }
  }

  return new RegExp(`^${src}$`) // nosemgrep: detect-non-literal-regexp — patterns come from hardcoded GENERATED_FILE_PATTERNS or .lceignore (developer-controlled, not user input)
}

/** Escape regex-special characters in a literal string segment. */
function escapeGlob(segment: string): string {
  return segment.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

/**
 * Legacy overload — check against patterns array only (no negation support).
 * @deprecated Use shouldIgnore(filePath, LceIgnoreResult) instead.
 */
export function shouldIgnore(filePath: string, patterns: string[]): boolean
/**
 * Full overload — check against LceIgnoreResult with negation support.
 */
export function shouldIgnore(filePath: string, config: LceIgnoreResult): boolean
export function shouldIgnore(filePath: string, config: string[] | LceIgnoreResult): boolean {
  if (Array.isArray(config)) {
    // Legacy: patterns array only
    const normalized = filePath.replace(/\\/g, "/")
    for (const pattern of config) {
      if (!pattern) continue
      const regex = globToRegex(pattern)
      if (regex.test(normalized)) return true
      if (!pattern.includes("*") && normalized.endsWith(`/${pattern}`)) {
        return true
      }
    }
    return false
  }
  // Full config with negation support
  return shouldIgnoreWithConfig(filePath, config)
}

function shouldIgnoreWithConfig(filePath: string, config: LceIgnoreResult): boolean {
  const normalized = filePath.replace(/\\/g, "/")

  // Check negations first — if matched, force-include (return false)
  for (const pattern of config.negations ?? []) {
    if (!pattern) continue
    const regex = globToRegex(pattern)
    if (regex.test(normalized)) return false
    if (!pattern.includes("*") && normalized.endsWith(`/${pattern}`)) {
      return false
    }
  }

  for (const pattern of config.globs) {
    if (!pattern) continue
    const regex = globToRegex(pattern)
    if (regex.test(normalized)) return true
    if (!pattern.includes("*") && normalized.endsWith(`/${pattern}`)) {
      return true
    }
  }

  return false
}
