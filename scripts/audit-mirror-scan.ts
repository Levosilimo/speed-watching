#!/usr/bin/env bun
/**
 * audit-mirror-scan — advisory lane: tests are written from the spec and
 * real fixtures, never from the implementation (AGENTS.md: Independent
 * lane). A test that repeats a private literal of the code it tests cannot
 * fail for the right reason.
 *
 * For each test file: resolve its relative imports, collect the values of
 * non-exported top-level const/let/var declarations that occur exactly once
 * in the imported lib (the distinctive private constants), and flag any
 * that also appear verbatim in the test — the mirror signature. Numbers
 * and strings are matched by their raw text.
 *
 * Exit 1 under LCE_STRICT_MIRROR=1 when findings exist; advisory otherwise.
 * Paths on argv override the default test-file discovery under tests/.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ScanFinding {
  file: string;
  line?: number;
  message: string;
}

const SPECIFIER = /(?:from\s+|import\s*)['"]([^'"]+)['"]/g;
const STRING = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const NUMBER = /-?\b\d+(?:\.\d+)?\b/g;

type Literals = Map<string, { kind: 'string' | 'number'; count: number }>;

export function discoverTestFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.test.ts')) {
        files.push(full);
      }
    }
  };
  walk(join(root, 'tests'));
  return files.sort();
}

function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote !== null) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function collectLiterals(code: string): Literals {
  const literals: Literals = new Map();
  const add = (kind: 'string' | 'number', text: string): void => {
    const entry = literals.get(text);
    if (entry) {
      entry.count++;
    } else {
      literals.set(text, { kind, count: 1 });
    }
  };
  for (const m of code.matchAll(STRING)) add('string', m[0]);
  for (const m of code.matchAll(NUMBER)) add('number', m[0]);
  return literals;
}

/** Values of non-exported top-level const/let/var declarations — the
 * private constants a test could only know by reading the implementation.
 * Import specifiers and expression literals are not signatures. */
function collectInternals(source: string): Literals {
  const code = stripComments(source);
  const literals: Literals = new Map();
  const add = (kind: 'string' | 'number', text: string): void => {
    const entry = literals.get(text);
    if (entry) {
      entry.count++;
    } else {
      literals.set(text, { kind, count: 1 });
    }
  };
  let depth = 0;
  let exported = false;
  let collecting = false;
  for (const raw of code.split('\n')) {
    const line = raw.trim();
    if (depth === 0 && line !== '' && !exported) {
      exported = /^export(\s|$)/.test(line);
      // Object/array catalogs are data, not implementation signatures.
      if (!exported) collecting = /^(const|let|var)\s+\w+/.test(line) && !/=\s*[{[]/.test(line);
    }
    if (!exported && collecting) {
      if (/^[{[]/.test(line)) {
        collecting = false; // multi-line object/array initializer
      } else {
        for (const m of line.matchAll(STRING)) add('string', m[0]);
        for (const m of line.matchAll(NUMBER)) add('number', m[0]);
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    if (depth === 0) {
      exported = false;
      collecting = false;
    }
  }
  return literals;
}

export function resolveLibImports(testFile: string): string[] {
  const source = readFileSync(testFile, 'utf8');
  const libs: string[] = [];
  for (const m of source.matchAll(SPECIFIER)) {
    const spec = m[1]!;
    if (!spec.startsWith('.')) continue;
    for (const candidate of [spec, `${spec}.ts`, `${spec}.tsx`, `${spec}.js`, `${spec}/index.ts`]) {
      const full = resolve(dirname(testFile), candidate);
      if (existsSync(full)) {
        libs.push(full);
        break;
      }
    }
  }
  return [...new Set(libs)];
}

export function scanMirrorScan(testFiles: string[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const testFile of testFiles) {
    const testValues = new Set(collectLiterals(stripComments(readFileSync(testFile, 'utf8'))).keys());
    for (const libFile of resolveLibImports(testFile)) {
      const internals = collectInternals(readFileSync(libFile, 'utf8'));
      for (const [literal, { kind, count }] of internals) {
        if (count === 1 && testValues.has(literal)) {
          findings.push({
            file: testFile,
            message: `${kind} ${literal} mirrors ${libFile}'s non-exported internals`,
          });
        }
      }
    }
  }
  return findings;
}
