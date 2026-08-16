// The invariant catalog: deterministic property tests (house SEED 4242)
// over the rate/recommend/tokenizer surface, authored from the research
// frame — plan-v2's 250–275 wpm safe zone, plan-v3's daisy-chain rules,
// docs/languages.md's derived-estimate rules, and the recorded payloads —
// NOT from lib/ constants. A property that mirrors a lib constant cannot
// fail for the right reason; each property below is written to the
// research claim and must be able to fail if the code drifts.
import fc from 'fast-check';
import { describe, expect, it, vi, type Mock } from 'vitest';
import type { Segment } from '../lib/captions';
import { parseYouTubeJson3 } from '../lib/captions';
import { ChannelMemory } from '../lib/channel-memory';
import { LANGUAGES } from '../lib/languages';
import {
  createBridgeClient,
  createBridgeListener,
  type BridgeDeps,
  type BridgeRequest,
  type EventHost,
} from '../lib/messaging';
import { OverrideLog } from '../lib/override-log';
import { recommend } from '../lib/recommend';
import { defaultSettings, SettingsStore } from '../lib/settings';
import { SkipSilenceStore, defaultSkipSilence } from '../lib/skip-silence';
import { countMorae, countWordTokens, isBracketMarker } from '../lib/tokenizer';
import {
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  wordLevelWpm,
} from '../lib/wpm';
import { readFixture, mockStorage } from './fixtures/helpers';

const SEED = 4242;

const TEXT_CORPUS = [
  'hello world',
  'the quick brown fox jumps over the lazy dog',
  '[Music]',
  '♪ la la ♪',
  '42 percent of people agree',
  'one two three four five',
];

/** Cues with strictly increasing starts and positive durations. */
const cuesArb: fc.Arbitrary<Segment[]> = fc
  .array(
    fc.record({
      start: fc.double({ min: 0, max: 1000, noNaN: true }),
      dur: fc.double({ min: 0.1, max: 30, noNaN: true }),
      text: fc.constantFrom(...TEXT_CORPUS),
    }),
    { minLength: 2, maxLength: 15 },
  )
  .map((specs) =>
    [...specs]
      .sort((a, b) => a.start - b.start)
      .map((spec, index) => ({
        text: spec.text,
        startSec: spec.start + index,
        durSec: spec.dur,
      })),
  );

/** Cues whose spoken subset never overlaps: starts ≥ 2 s apart with
 * durations ≤ 0.9 s, so Σ spoken durations ≤ the trimmed spoken span. */
const nonOverlapCuesArb: fc.Arbitrary<Segment[]> = fc
  .array(
    fc.record({
      start: fc.double({ min: 0, max: 1000, noNaN: true }),
      dur: fc.double({ min: 0.1, max: 0.9, noNaN: true }),
      text: fc.constantFrom(...TEXT_CORPUS),
    }),
    { minLength: 2, maxLength: 15 },
  )
  .map((specs) =>
    [...specs]
      .sort((a, b) => a.start - b.start)
      .map((spec, index) => ({
        text: spec.text,
        startSec: spec.start + index * 2,
        durSec: spec.dur,
      })),
  );

// (a) recommend bounds — the plan-v2 safe-zone frame: target 250 (the
// low end of the 250–275 band, plan-v3), ceiling 275 with the documented
// ±5% content-type modulation (multimedia offload up, podcasts down).
describe('recommend safe-zone invariants (the 250–275 wpm frame)', () => {
  const inputArb = fc.record({
    naturalRate: fc.double({ min: 20, max: 400, noNaN: true }),
    tier: fc.constantFrom('asr-word', 'asr-cue', 'manual-cue', 'estimated'),
    contentType: fc.constantFrom(
      'lecture',
      'talk',
      'explainer',
      'news',
      'podcast',
      'music',
      'generic',
      'unknown',
    ),
    platformMax: fc.double({ min: 1, max: 2.5, noNaN: true }),
  });

  it('clamps the multiplier into [slow-down floor, platform max]', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const rec = recommend(input);
        const floor = Math.min(0.5, input.platformMax);
        expect(rec.multiplier).toBeGreaterThanOrEqual(floor - 1e-9);
        expect(rec.multiplier).toBeLessThanOrEqual(input.platformMax + 1e-9);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('keeps effectiveWpm exactly naturalRate × multiplier', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const rec = recommend(input);
        expect(rec.effectiveWpm).toBe(input.naturalRate * rec.multiplier);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('never recommends past 1.5x on the manual-cue tier', () => {
    // The ora-1 #5 conservative clamp: the least-validated tier stays
    // bounded even when its rate estimate is off. The unreachable report
    // is exempt — it shows platformMax as the honest "cannot reach the
    // safe zone" number, not a recommendation.
    fc.assert(
      fc.property(inputArb, (input) => {
        const rec = recommend({ ...input, tier: 'manual-cue' });
        if (rec.mode === 'unreachable') return;
        expect(rec.multiplier).toBeLessThanOrEqual(1.5 + 1e-9);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('keeps clean recommendations inside the modulated safe zone', () => {
    // Warning fires at ceiling = 275 × factor (1.05 lectures/explainers,
    // 0.95 podcasts, 1 otherwise), so a recommend-mode recommendation
    // stays under the widest modulated ceiling, and an above-zone warning
    // means the rate crossed the narrowest one.
    fc.assert(
      fc.property(inputArb, (input) => {
        const rec = recommend(input);
        if (rec.mode === 'recommend') {
          expect(rec.effectiveWpm).toBeLessThanOrEqual(275 * 1.05 + 1e-9);
        }
        if (rec.reason === 'above-zone') {
          expect(rec.effectiveWpm).toBeGreaterThan(275 * 0.95 - 1e-9);
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('warns capped-below only under the 250 target', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const rec = recommend(input);
        if (rec.reason === 'capped-below') {
          expect(rec.effectiveWpm).toBeLessThan(250);
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('reports unreachable exactly when platform max cannot reach the target', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        if (input.contentType === 'music') return; // music never recommends
        const rec = recommend(input);
        if (input.naturalRate * input.platformMax < 250) {
          expect(rec.mode).toBe('unreachable');
          expect(rec.multiplier).toBe(input.platformMax);
          expect(rec.effectiveWpm).toBeLessThan(250);
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// (b) span-trimming invariance — the unified rule's trimmed-span contract
// (plan-v3 rule 1: first-to-last non-bracket cue).
describe('span-trimming invariants', () => {
  it('inserting a strictly interior spoken cue keeps first/last starts — the rate never drops', () => {
    fc.assert(
      fc.property(cuesArb, fc.constantFrom('hello world', 'one two three', '42 percent of people agree'), (cues, insertText) => {
        const spoken = cues.filter((cue) => !isBracketMarker(cue.text));
        if (spoken.length < 2) return;
        const before = filteredTokensOverTrimmedSpan(cues);
        if (before === null) return;
        const lo = spoken[0]!.startSec;
        const hi = spoken.at(-1)!.startSec;
        const inserted = [...cues, { text: insertText, startSec: lo + (hi - lo) / 2, durSec: 1 }].sort(
          (a, b) => a.startSec - b.startSec,
        );
        const after = filteredTokensOverTrimmedSpan(inserted);
        expect(after).not.toBeNull();
        expect(after!).toBeGreaterThanOrEqual(before);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('removing bracket-only cues is rate-invariant', () => {
    fc.assert(
      fc.property(cuesArb, (cues) => {
        const stripped = cues.filter((cue) => !isBracketMarker(cue.text));
        for (const rate of [filteredTokensOverTrimmedSpan, manualCueRate]) {
          const before = rate(cues);
          if (before === null) {
            expect(rate(stripped)).toBeNull();
            continue;
          }
          const after = rate(stripped);
          expect(after).not.toBeNull();
          expect(after!).toBeCloseTo(before, 9);
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// (c) transcript-equivalent transformations — the pipeline collapses
// whitespace and strips boundary punctuation; the tokenizers must count
// the same tokens before and after.
const TEXT_ATOMS = [
  // Letters/digits; combining marks pre-attached to their base so the
  // generated text is well-formed (marks never dangle after punctuation).
  'a', 'B', '3', '0', '日', '本', 'あ', 'ん', 'क', 'ह', 'क\u094D', 'a\u0301',
  ' ', '\n', '\t', ',', '.', ';', '!', '?', '(', ')', '[', ']', '{', '}', '-', "'", '"', '♪', '♫', '…',
];

const textArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...TEXT_ATOMS), { minLength: 0, maxLength: 40 })
  .map((atoms) => atoms.join(''));

/** Drops punctuation/symbol blocks not flanked by letter/digit/mark on
 * both sides — the only stripping that cannot merge or split word runs.
 * Blocks are stripped whole: dropping part of a block would move the
 * survivors' neighbors and could join two runs ("a,[a" → "aa"). */
function stripBoundaryPunct(text: string): string {
  const chars = [...text];
  const runChar = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}\p{M}]/u.test(c);
  const out: string[] = [];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    if (!/[\p{P}\p{S}]/u.test(ch)) {
      out.push(ch);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < chars.length && /[\p{P}\p{S}]/u.test(chars[j]!)) j++;
    if (runChar(out.at(-1)) && runChar(chars[j])) {
      for (let k = i; k < j; k++) out.push(chars[k]!);
    }
    i = j;
  }
  return out.join('');
}

/** The transcript pipeline's normalization: whitespace collapsed and
 * trimmed, boundary punctuation stripped. */
function normalizeTranscript(text: string): string {
  return stripBoundaryPunct(text)
    .replace(/\s+/g, ' ')
    .trim();
}

describe('transcript-equivalent tokenization', () => {
  it('counts the same tokens under whitespace collapsing and boundary punctuation stripping', () => {
    fc.assert(
      fc.property(textArb, (text) => {
        const normalized = normalizeTranscript(text);
        for (const mode of ['words', 'words-marks', 'chars', 'mora'] as const) {
          expect(countWordTokens(normalized, mode)).toBe(countWordTokens(text, mode));
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// (d) tokenizer-mode consistency.
describe('tokenizer-mode consistency', () => {
  it('chars never counts more tokens than code points', () => {
    fc.assert(
      fc.property(textArb, (text) => {
        expect(countWordTokens(text, 'chars')).toBeLessThanOrEqual([...text].length);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('words-marks never counts more runs than words — marks merge runs, never split them', () => {
    // The task spec phrased this 'words-marks ≥ words'; the documented
    // purpose of the marks mode is the opposite direction — "\p{M} keeps
    // combining marks inside the run" (the plain run fragments Hindi
    // words into ~1.5x too many tokens) — so marks can only merge runs.
    fc.assert(
      fc.property(textArb, (text) => {
        expect(countWordTokens(text, 'words-marks')).toBeLessThanOrEqual(countWordTokens(text, 'words'));
        // Mark-free text has no runs to merge: both modes count alike.
        if (!/[\p{M}]/u.test(text)) {
          expect(countWordTokens(text, 'words-marks')).toBe(countWordTokens(text, 'words'));
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('stays inside the documented 1.8–2.0 morae-per-kanji band', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...'日月火水木金土山川'), { minLength: 1, maxLength: 30 }),
        (kanji) => {
          const perKanji = countMorae(kanji.join('')) / kanji.length;
          expect(perKanji).toBeGreaterThanOrEqual(1.8);
          expect(perKanji).toBeLessThanOrEqual(2.0);
        },
      ),
      { seed: SEED, numRuns: 100 },
    );
  });
});

// (e) language-model invariants — docs/languages.md's derived-estimate
// rules: priors are ranges, targets never exceed ceilings, measured pause
// shares are proper fractions, and ratio-derived ceilings sit at the
// documented ≈1.03 of their targets. The researched pairs (comprehension-
// or corpus-anchored ceilings) are exempt from the ratio band: en/zh/ja
// (measured ceilings), ar (measured 300–360 syllabic band), ru/uk/pl/cs/sr
// (corpus headroom).
const RESEARCHED_CEILING = new Set(['en', 'zh', 'ja', 'ar', 'ru', 'uk', 'pl', 'cs', 'sr']);

/** A language whose ceiling is genuinely measured or corpus-anchored — the
 * model's own evidence flags: a measured entry (!derived) or a
 * corpus-researched one (priorsSource 'corpus'). */
function researchedCeiling(code: string): boolean {
  const model = LANGUAGES[code];
  return model !== undefined && (model.derived === false || model.priorsSource === 'corpus');
}

describe('language-model invariants', () => {
  it('keeps every prior a range — generic and per-register', () => {
    for (const model of Object.values(LANGUAGES)) {
      expect(model.priors.min, model.code).toBeLessThanOrEqual(model.priors.max);
      for (const band of Object.values(model.registerPriors ?? {})) {
        expect(band.min, model.code).toBeLessThanOrEqual(band.max);
      }
    }
  });

  it('never lets a target exceed its ceiling', () => {
    for (const model of Object.values(LANGUAGES)) {
      expect(model.target, model.code).toBeLessThanOrEqual(model.ceiling);
    }
  });

  it('keeps measured pause shares inside (0, 1)', () => {
    for (const model of Object.values(LANGUAGES)) {
      if (model.pauseShare === undefined) continue;
      expect(model.pauseShare, model.code).toBeGreaterThan(0);
      expect(model.pauseShare, model.code).toBeLessThan(1);
    }
  });

  it('holds derived entries to the ≈1.03 ceiling:target ratio — researched pairs excepted', () => {
    for (const model of Object.values(LANGUAGES)) {
      if (!model.derived || RESEARCHED_CEILING.has(model.code)) continue;
      const ratio = model.ceiling / model.target;
      expect(ratio, model.code).toBeGreaterThanOrEqual(1.0);
      expect(ratio, model.code).toBeLessThanOrEqual(1.05);
    }
  });

  it('keeps the ratio-band exemption set inside the genuinely researched languages', () => {
    // Cross-check for the hardcoded set: an exempt code must exist in the
    // model and carry a measured (!derived) or corpus-researched
    // (priorsSource 'corpus') ceiling. A plain derived language added to
    // the set fails here — before the ratio test can silently accept it.
    for (const code of RESEARCHED_CEILING) {
      expect(researchedCeiling(code), code).toBe(true);
    }
  });
});

// (f) cross-tier differential properties — the documented bias order:
// plan-v3 rule 1 (naive word-level is a ~16% undercount), rule 3 (silence
// correction raises the manual rate +3.1–15.0%), and the pause-excluded
// beats pause-included claim.
describe('cross-tier rate differentials', () => {
  it('unified never runs below word-level on dense ASR timing', () => {
    // Dense ASR timing model: every spoken cue carries ≥2 tokens and its
    // tokens are timed at the cue start; the first token per cue is the
    // untimed lead the naive path drops (the ~16% undercount). The word
    // span then equals the unified span and the token counts differ only
    // by the dropped leads.
    const denseCorpus = [
      'hello world',
      'the quick brown fox jumps over the lazy dog',
      '42 percent of people agree',
      'one two three four five',
      '[Music]',
    ];
    const denseArb: fc.Arbitrary<Segment[]> = fc
      .array(
        fc.record({
          start: fc.double({ min: 0, max: 1000, noNaN: true }),
          dur: fc.double({ min: 0.1, max: 30, noNaN: true }),
          text: fc.constantFrom(...denseCorpus),
        }),
        { minLength: 2, maxLength: 15 },
      )
      .map((specs) =>
        [...specs]
          .sort((a, b) => a.start - b.start)
          .map((spec, index) => ({ text: spec.text, startSec: spec.start + index, durSec: spec.dur })),
      );
    fc.assert(
      fc.property(denseArb, (cues) => {
        const spoken = cues.filter((cue) => !isBracketMarker(cue.text));
        if (spoken.length < 2) return;
        const words: Segment[] = [];
        for (const cue of spoken) {
          for (const token of (cue.text.match(/\S+/g) ?? []).slice(1)) {
            words.push({ text: token, startSec: cue.startSec });
          }
        }
        const unified = filteredTokensOverTrimmedSpan(cues);
        const word = wordLevelWpm(words);
        expect(unified).not.toBeNull();
        expect(word).not.toBeNull();
        expect(unified!).toBeGreaterThanOrEqual(word!);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('runs at least as high as word-level on the recorded ASR payload', () => {
    const { words, cues } = parseYouTubeJson3(readFixture('real/asr-word.json'));
    const unified = filteredTokensOverTrimmedSpan(cues);
    const word = wordLevelWpm(words);
    if (unified === null || word === null) {
      throw new Error('wpm must be computable on the fixture');
    }
    expect(unified).toBeGreaterThanOrEqual(word);
  });

  it('the silence-corrected manual rate never runs below the pause-included rate', () => {
    fc.assert(
      fc.property(nonOverlapCuesArb, (cues) => {
        const unified = filteredTokensOverTrimmedSpan(cues);
        if (unified === null) return; // one spoken cue: no span to compare
        const accurate = manualCueRate(cues);
        expect(accurate).not.toBeNull();
        expect(accurate!).toBeGreaterThanOrEqual(unified);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('the corrected cue rate never runs below the raw cue rate', () => {
    fc.assert(
      fc.property(cuesArb, (cues) => {
        const raw = cueLevelWpm(cues);
        if (raw === null) return;
        const corrected = correctedCueLevelWpm(cues);
        expect(corrected).not.toBeNull();
        expect(corrected!).toBeGreaterThanOrEqual(raw);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// (g) bridge write-bound catalog (C1): every WRITE message in the bridge
// union (lib/bridge-protocol.ts) with every bounded field, its documented
// bound, and the out-of-bounds payload the wire guard must reject. The
// catalog is keyed on the write side of the union — a new write message
// type without an entry fails to COMPILE (Record<WriteType, …>), so the
// table cannot silently go stale. Bounds are written from the guards'
// documented ranges (lib/bridge-protocol.ts), not from lib constants.

type WriteType = Exclude<BridgeRequest['type'], 'settings:get' | 'skip:get' | 'channel:get'>;

interface FieldEntry {
  field: string;
  /** The documented bound, as the guard's comment states it. */
  bound: string;
  /** A payload with exactly this field out of bounds. */
  corrupt: BridgeRequest;
  /** The rejection the handler throws for this message type. */
  error: string;
}

const WRITE_CATALOG: Record<WriteType, FieldEntry[]> = {
  // One-flag write with no payload fields: nothing a page can forge.
  'settings:seenFirstRun': [],
  'settings:set': [
    { field: 'settings.target', bound: '[100, 400] wpm', error: 'invalid settings payload', corrupt: { type: 'settings:set', settings: { ...defaultSettings(), target: 500 } } },
    { field: 'settings.platformMax', bound: '[1, 4]x', error: 'invalid settings payload', corrupt: { type: 'settings:set', settings: { ...defaultSettings(), platformMax: 10 } } },
    { field: 'settings.sites[].target', bound: '[100, 400] wpm', error: 'invalid settings payload', corrupt: { type: 'settings:set', settings: { ...defaultSettings(), sites: { 'youtube.com': { target: 900 } } } } },
    { field: 'settings.sites[].platformMax', bound: '[1, 4]x', error: 'invalid settings payload', corrupt: { type: 'settings:set', settings: { ...defaultSettings(), sites: { 'youtube.com': { platformMax: 9 } } } } },
    { field: 'settings.contentTypes[].target', bound: '[100, 400] wpm', error: 'invalid settings payload', corrupt: { type: 'settings:set', settings: { ...defaultSettings(), contentTypes: { lecture: { target: 700 } } } } },
  ],
  'skip:set': [
    { field: 'prefs.minGapSec', bound: '[1, 60] s', error: 'invalid prefs', corrupt: { type: 'skip:set', prefs: { ...defaultSkipSilence(), minGapSec: 61 } } },
    { field: 'prefs.pauseRate', bound: '[1, 1.3]x', error: 'invalid prefs', corrupt: { type: 'skip:set', prefs: { ...defaultSkipSilence(), pauseRate: 2 } } },
  ],
  'log:append': [
    { field: 'entry.naturalRate', bound: '[1, 1000] wpm', error: 'log:append: invalid entry', corrupt: { type: 'log:append', entry: { site: 'youtube.com', contentType: 'talk', naturalRate: 5000, multiplier: 1.5, mode: 'recommend', userAction: 'apply' } } },
    { field: 'entry.multiplier', bound: '[0.1, 10]x', error: 'log:append: invalid entry', corrupt: { type: 'log:append', entry: { site: 'youtube.com', contentType: 'talk', naturalRate: 150, multiplier: 20, mode: 'recommend', userAction: 'apply' } } },
    { field: 'entry.finalMultiplier', bound: '[0.1, 10]x', error: 'log:append: invalid entry', corrupt: { type: 'log:append', entry: { site: 'youtube.com', contentType: 'talk', naturalRate: 150, multiplier: 1.5, finalMultiplier: -2, mode: 'recommend', userAction: 'adjust' } } },
  ],
  'channel:put': [
    { field: 'channelKey', bound: '1..200 chars', error: 'channel:put: invalid record', corrupt: { type: 'channel:put', channelKey: 'x'.repeat(201), record: { rate: 150, unit: 'wpm', language: 'en', ts: 1 } } },
    { field: 'record.rate', bound: '[1, 1000] wpm', error: 'channel:put: invalid record', corrupt: { type: 'channel:put', channelKey: 'UC-a', record: { rate: 5000, unit: 'wpm', language: 'en', ts: 1 } } },
  ],
  'demand:increment': [
    { field: 'contentType', bound: 'ContentType enum', error: 'unknown content type', corrupt: { type: 'demand:increment', contentType: 'bogus' as never } },
  ],
  'journal:append': [
    { field: 'reason', bound: 'CaptionStatus enum', error: 'journal:append: invalid entry', corrupt: { type: 'journal:append', reason: 'bogus' as never } },
  ],
  'nudge:recordApply': [
    { field: 'multiplier', bound: '[0.1, 10]x', error: 'nudge:recordApply: invalid multiplier', corrupt: { type: 'nudge:recordApply', multiplier: 50 } },
  ],
  'nudge:dismiss': [
    { field: 'forever', bound: 'boolean', error: 'nudge:dismiss: invalid forever flag', corrupt: { type: 'nudge:dismiss', forever: 'yes' as never } },
  ],
  'timeSaved:accrue': [
    { field: 'deltaSec', bound: '[0, 10] s (one flush interval)', error: 'timeSaved:accrue: invalid accrue payload', corrupt: { type: 'timeSaved:accrue', deltaSec: 1e12, multiplier: 2 } },
    { field: 'multiplier', bound: '[0.1, 10]x', error: 'timeSaved:accrue: invalid accrue payload', corrupt: { type: 'timeSaved:accrue', deltaSec: 10, multiplier: 99 } },
  ],
};

/** The bridge round-trip harness: a client and a listener sharing one
 * same-frame host, with spies standing in for every background forwarder. */
function catalogServe(): { client: ReturnType<typeof createBridgeClient>; forwards: Mock[] } {
  const listeners = new Set<(event: MessageEvent) => void>();
  const host: EventHost & { location: { hostname: string } } = {
    location: { hostname: 'youtube.com' },
    postMessage: (message: unknown) => {
      for (const listener of listeners) listener({ data: message, source: host } as MessageEvent);
    },
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === 'message') listeners.add(listener);
    },
  };
  const forwardDemand = vi.fn();
  const forwardJournalAppend = vi.fn();
  const forwardNudgeRecordApply = vi.fn();
  const forwardNudgeDismiss = vi.fn();
  const forwardAccrue = vi.fn();
  const forwardChannelPut = vi.fn();
  const deps: BridgeDeps = {
    settings: new SettingsStore(mockStorage()),
    skip: new SkipSilenceStore(mockStorage()),
    log: new OverrideLog(mockStorage()),
    channels: new ChannelMemory(mockStorage()),
    forwardDemand,
    forwardJournalAppend,
    forwardNudgeRecordApply,
    forwardNudgeDismiss,
    forwardAccrue,
    forwardChannelPut,
  };
  host.addEventListener('message', createBridgeListener(deps, host as unknown as Window));
  return {
    client: createBridgeClient(host),
    forwards: [
      forwardDemand,
      forwardJournalAppend,
      forwardNudgeRecordApply,
      forwardNudgeDismiss,
      forwardAccrue,
      forwardChannelPut,
    ],
  };
}

describe('bridge write-bound catalog (C1)', () => {
  it('rejects an out-of-bounds payload for every bounded field of every write message', async () => {
    for (const [type, fields] of Object.entries(WRITE_CATALOG)) {
      for (const entry of fields) {
        const { client, forwards } = catalogServe();
        await expect(
          client.request(entry.corrupt),
          `${type}.${entry.field} outside ${entry.bound} must be rejected`,
        ).rejects.toThrow(entry.error);
        // Nothing crossed to the background: every forwarder stayed silent.
        for (const forward of forwards) expect(forward, type).not.toHaveBeenCalled();
      }
    }
  });
});
