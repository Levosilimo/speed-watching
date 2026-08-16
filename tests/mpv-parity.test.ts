import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, UNIT_LABELS } from '../lib/languages';
import type { LanguageModel } from '../lib/languages';

// Parity spec: mpv/languages.lua must mirror lib/languages.ts for every
// language the port carries. The port mirrors the manual-cue fields (code,
// unit, tokenizer, target, ceiling, priors, and the optional extras it
// already carries: syllables_per_word, hangul_blocks, register_priors) —
// the asr-tier-only fields (registerPriors elsewhere, priorsSource,
// pauseShare, derived) are deliberately not ported.
const languagesLua = readFileSync(
  fileURLToPath(new URL('../mpv/languages.lua', import.meta.url)),
  'utf8',
);

interface Entry {
  fields: Record<string, string | number | boolean>;
  priors: { min: number; max: number } | null;
  register: Record<string, { min: number; max: number }> | null;
}

/** Scalar field name in the Lua entry → its counterpart in LanguageModel. */
const SCALAR_FIELDS: Record<string, keyof LanguageModel> = {
  code: 'code',
  unit: 'unit',
  tokenizer: 'tokenizerMode',
  target: 'target',
  ceiling: 'ceiling',
  syllables_per_word: 'syllablesPerWord',
  hangul_blocks: 'hangulBlocks',
};

const MANDATORY_FIELDS = ['code', 'unit', 'tokenizerMode', 'target', 'ceiling'] as const;

const netBraces = (s: string): number =>
  (s.match(/\{/g) ?? []).length - (s.match(/\}/g) ?? []).length;

function extractEntries(src: string): Map<string, Entry> {
  const entries = new Map<string, Entry>();
  let current: string | null = null;
  let depth = 0;
  let body: string[] = [];

  const flush = (): void => {
    const text = body.join('\n');
    const fields: Entry['fields'] = {};
    for (const [luaName, tsName] of Object.entries(SCALAR_FIELDS)) {
      const scalar = new RegExp(`${luaName} = ("[^"]+"|\\d+(?:\\.\\d+)?|true|false)`).exec(text);
      if (scalar !== null) {
        const raw = scalar[1]!;
        fields[tsName] = raw.startsWith('"')
          ? raw.slice(1, -1)
          : raw === 'true'
            ? true
            : raw === 'false'
              ? false
              : Number(raw);
      }
    }
    const priors = /priors = \{ min = (\d+), max = (\d+) \}/.exec(text);
    const register: Entry['register'] = {};
    for (const m of text.matchAll(/^ {6}(\w+) = \{ min = (\d+), max = (\d+) \},?$/gm)) {
      register[m[1]!] = { min: Number(m[2]!), max: Number(m[3]!) };
    }
    entries.set(current!, {
      fields,
      priors: priors === null ? null : { min: Number(priors[1]), max: Number(priors[2]) },
      register: Object.keys(register).length === 0 ? null : register,
    });
    current = null;
  };

  for (const line of src.split('\n')) {
    if (current === null) {
      const oneLiner = line.match(/^  ([a-z]{2}) = \{(.*)\},?$/);
      if (oneLiner !== null) {
        current = oneLiner[1]!;
        body = [oneLiner[2]!];
        flush();
      } else {
        const open = line.match(/^  ([a-z]{2}) = \{$/);
        if (open !== null) {
          current = open[1]!;
          depth = 1;
          body = [];
        }
      }
      continue;
    }
    depth += netBraces(line);
    if (depth > 0) {
      body.push(line);
    } else {
      flush();
    }
  }
  return entries;
}

describe('mpv languages parity', () => {
  it('mirrors lib/languages.ts for every shared language', () => {
    const entries = extractEntries(languagesLua);
    expect(entries.size).toBeGreaterThan(0);
    for (const [code, entry] of entries) {
      const lib = LANGUAGES[code];
      if (lib === undefined) throw new Error(`lib has no ${code}`);
      for (const field of MANDATORY_FIELDS) {
        expect(entry.fields[field], `${code}.${field} present in the Lua table`).toBeDefined();
        expect(entry.fields[field], `${code}.${field}`).toBe(lib[field]);
      }
      expect(entry.priors, `${code} carries priors`).not.toBeNull();
      expect(entry.priors, `${code}.priors`).toEqual(lib.priors);
      for (const field of ['syllablesPerWord', 'hangulBlocks'] as const) {
        if (entry.fields[field] !== undefined) {
          expect(entry.fields[field], `${code}.${field}`).toBe(lib[field]);
        }
      }
      if (entry.register !== null) {
        expect(lib.registerPriors, `${code} carries register priors in the lib`).toBeDefined();
        expect(entry.register, `${code}.register_priors`).toEqual(lib.registerPriors);
      }
    }
  });

  it('mirrors UNIT_LABELS', () => {
    const match = /languages\.UNIT_LABELS = \{ ([^}]+) \}/.exec(languagesLua);
    expect(match).not.toBeNull();
    const lua: Record<string, string> = {};
    for (const m of match![1]!.matchAll(/(\w+) = "([^"]+)"/g)) {
      lua[m[1]!] = m[2]!;
    }
    expect(lua).toEqual(UNIT_LABELS);
  });
});
