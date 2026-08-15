// Deterministic output pins for the rate derivations, authored from the
// RECORDED values — the real fixtures (tests/fixtures/real) and the
// hand-computed anchor fixtures in the wpm suite — never copied from
// lib/ internals. A refactor that silently shifts a computed rate fails
// on the snapshot diff; the pinned values are the recorded truth, so a
// drift surfaces as a discrepancy to reconcile, not a silent update.
import { describe, expect, it } from 'vitest';
import type { Segment } from '../lib/captions';
import { parseYouTubeJson3 } from '../lib/captions';
import { LANGUAGES } from '../lib/languages';
import { recommend } from '../lib/recommend';
import { filteredTokensOverTrimmedSpan, manualCueRate } from '../lib/wpm';
import { readFixture } from './fixtures/helpers';

const round2 = (n: number): number => Math.round(n * 100) / 100;

describe('pinned derived rates (recorded values)', () => {
  it('pins the language-unit anchor rates', () => {
    // The anchor fixtures from the wpm suite: two spoken cues one second
    // apart, in each language's unit — es 4 word runs, ja 15.4 morae,
    // hi 8 vowel nuclei, tr 10 vowel letters, ko 7 Hangul blocks.
    const cases: Record<string, { language: keyof typeof LANGUAGES; cues: Segment[] }> = {
      es: {
        language: 'es',
        cues: [
          { text: 'hola mundo', startSec: 0, durSec: 3 },
          { text: 'buenos días', startSec: 1, durSec: 2 },
        ],
      },
      ja: {
        language: 'ja',
        cues: [
          { text: 'こんにちは世界', startSec: 0, durSec: 3 },
          { text: '元気ですか', startSec: 2, durSec: 2 },
        ],
      },
      hi: {
        language: 'hi',
        cues: [
          { text: 'मैं जा रहा हूँ', startSec: 0, durSec: 2 },
          { text: 'मैं ठीक हूँ', startSec: 1, durSec: 1 },
        ],
      },
      tr: {
        language: 'tr',
        cues: [
          { text: 'merhaba dünya', startSec: 0, durSec: 2 },
          { text: 'bugün nasılsın', startSec: 1, durSec: 1 },
        ],
      },
      ko: {
        language: 'ko',
        cues: [
          { text: '안녕하세요', startSec: 0, durSec: 3 },
          { text: '세상', startSec: 1, durSec: 2 },
        ],
      },
    };
    const rates: Record<string, number> = {};
    for (const [name, { language, cues }] of Object.entries(cases)) {
      const rate = filteredTokensOverTrimmedSpan(cues, LANGUAGES[language]);
      if (rate === null) throw new Error(`rate must be computable for ${name}`);
      rates[name] = round2(rate);
    }
    expect(rates).toMatchInlineSnapshot(`
      {
        "es": 240,
        "hi": 480,
        "ja": 462,
        "ko": 420,
        "tr": 600,
      }
    `);
  });

  it('pins the recorded real-fixture rates', () => {
    const asr = parseYouTubeJson3(readFixture('real/asr-word.json'));
    const manual = parseYouTubeJson3(readFixture('real/manual-cue.json'));
    const unified = filteredTokensOverTrimmedSpan(asr.cues);
    const manualRate = manualCueRate(manual.cues);
    if (unified === null || manualRate === null) {
      throw new Error('rates must be computable on the recorded fixtures');
    }
    expect({ asrWordUnified: round2(unified), manualCue: round2(manualRate) }).toMatchInlineSnapshot(`
      {
        "asrWordUnified": 160.25,
        "manualCue": 181.76,
      }
    `);
  });

  it('pins the recommend derivation on the recorded rates', () => {
    // 250 / 160.25 → 1.55 (rounded to 0.05) ≈ 248 wpm; 250 / 181.76 →
    // 1.4 ≈ 254 wpm. Both stay inside the 250–275 frame, so both are
    // clean recommendations.
    const asrWord = recommend({
      naturalRate: 160.25,
      tier: 'asr-word',
      contentType: 'lecture',
      platformMax: 2,
    });
    const manualCue = recommend({
      naturalRate: 181.76,
      tier: 'manual-cue',
      contentType: 'lecture',
      platformMax: 2,
    });
    expect({
      asrWord: {
        multiplier: round2(asrWord.multiplier),
        effectiveWpm: Math.round(asrWord.effectiveWpm),
      },
      manualCue: {
        multiplier: round2(manualCue.multiplier),
        effectiveWpm: Math.round(manualCue.effectiveWpm),
      },
    }).toMatchInlineSnapshot(`
      {
        "asrWord": {
          "effectiveWpm": 248,
          "multiplier": 1.55,
        },
        "manualCue": {
          "effectiveWpm": 254,
          "multiplier": 1.4,
        },
      }
    `);
  });
});
