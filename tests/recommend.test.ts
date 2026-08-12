import { describe, expect, it } from 'vitest';
import { parseYouTubeJson3 } from '../lib/captions';
import type { RecommendInput, Recommendation } from '../lib/recommend';
import {
  ARTICULATORY_CEILING_WPM,
  MANUAL_CUE_CLAMP,
  P_STIMULUS,
  ROUNDING_STEP,
  SAFE_ZONE_CEILING_WPM,
  SLOW_DOWN_FLOOR,
  TARGET_WPM,
  TIER_LABELS,
  recommend,
} from '../lib/recommend';
import type { RateTier } from '../lib/recommend';
import { LANGUAGES } from '../lib/languages';
import {
  filteredTokensOverTrimmedSpan,
  totalWords,
  wordTierInputs,
} from '../lib/wpm';
import { readFixture } from './fixtures/helpers';

const asr = (naturalRate: number, platformMax = 2, userTarget?: number) =>
  recommend({ naturalRate, tier: 'asr-cue', contentType: 'lecture', platformMax, userTarget });

describe('recommend — constants', () => {
  it('pins the engine constants', () => {
    expect(TARGET_WPM).toBe(250);
    expect(SAFE_ZONE_CEILING_WPM).toBe(275);
    expect(ROUNDING_STEP).toBe(0.05);
    expect(MANUAL_CUE_CLAMP).toBe(1.5);
    expect(SLOW_DOWN_FLOOR).toBe(0.5);
    expect(P_STIMULUS).toBe(0.3);
    // 275 / (1 − 0.3): the presentation-rate cliff mapped onto the
    // pause-excluded articulatory rate.
    expect(ARTICULATORY_CEILING_WPM).toBeCloseTo(392.857, 3);
    expect(TIER_LABELS).toEqual({
      'asr-word': 'from captions',
      'asr-cue': 'from captions',
      'manual-cue': 'from captions (corrected)',
      estimated: 'estimated',
    });
  });
});

describe('recommend — multiplier math', () => {
  it('targets 250 wpm with 0.05 rounding (up and down)', () => {
    expect(asr(128).multiplier).toBeCloseTo(1.95, 6); // 250/128 = 1.953 → 1.95
    expect(asr(240).multiplier).toBeCloseTo(1.05, 6); // 1.042 → 1.05
    expect(asr(260).multiplier).toBeCloseTo(0.95, 6); // 0.962 → 0.95
    expect(asr(200).multiplier).toBeCloseTo(1.25, 6);
  });

  it('honors a user target', () => {
    const input: RecommendInput = { naturalRate: 200, tier: 'asr-cue', contentType: 'lecture', platformMax: 2, userTarget: 275 };
    const r: Recommendation = recommend(input);
    expect(r.multiplier).toBeCloseTo(1.4, 6);
    expect(r.effectiveWpm).toBeCloseTo(280, 6);
  });
});

describe('recommend — slow-down and clamps', () => {
  it('recommends <1.0x for fast talkers, no extra clamp on ASR tiers', () => {
    const r = asr(260);
    expect(r.multiplier).toBeLessThan(1);
    expect(r.mode).toBe('recommend');
    expect(r.effectiveWpm).toBeCloseTo(247, 6);
  });

  it('clamps the manual-cue tier at 1.5x and warns when that caps below the zone', () => {
    const r = recommend({
      naturalRate: 150,
      tier: 'manual-cue',
      contentType: 'talk',
      platformMax: 2,
    });
    expect(r.multiplier).toBe(MANUAL_CUE_CLAMP);
    expect(r.effectiveWpm).toBeCloseTo(225, 6);
    expect(r.mode).toBe('warning');
    expect(r.reason).toBe('capped-below');
    expect(r.label).toContain('capped');
  });

  it('lets a manual-cue rate near the zone pass unclamped', () => {
    const r = recommend({
      naturalRate: 180,
      tier: 'manual-cue',
      contentType: 'talk',
      platformMax: 2,
    });
    expect(r.multiplier).toBeCloseTo(1.4, 6);
    expect(r.mode).toBe('recommend');
  });

  it('caps at the platform maximum exactly at the boundary', () => {
    const r = asr(125);
    expect(r.multiplier).toBe(2);
    expect(r.effectiveWpm).toBeCloseTo(250, 6);
    expect(r.mode).toBe('recommend');
  });

  it('warns when the slow-down floor blocks the zone', () => {
    const r = asr(480);
    expect(r.multiplier).toBe(SLOW_DOWN_FLOOR);
    expect(r.effectiveWpm).toBeCloseTo(240, 6);
    expect(r.mode).toBe('warning');
    expect(r.reason).toBe('capped-below');
  });
});

describe('recommend — above-zone warning', () => {
  it('warns when a user target pushes the effective rate past the cliff', () => {
    // Target 280 on a 140-wpm talk: 2x ≈ 280 wpm — past the 275 cliff.
    const r = asr(140, 2, 280);
    expect(r.multiplier).toBe(2);
    expect(r.effectiveWpm).toBeCloseTo(280, 6);
    expect(r.mode).toBe('warning');
    expect(r.reason).toBe('above-zone');
    expect(r.label).not.toContain('capped');
  });

  it('warns on a high target even without hitting a clamp', () => {
    const r = asr(160, 2, 300);
    expect(r.multiplier).toBeCloseTo(1.9, 6); // 300/160 = 1.875 → 1.9
    expect(r.effectiveWpm).toBeCloseTo(304, 6);
    expect(r.mode).toBe('warning');
    expect(r.reason).toBe('above-zone');
  });

  it('the cliff outranks the clamp cap when both apply', () => {
    const r = recommend({
      naturalRate: 190,
      tier: 'manual-cue',
      contentType: 'talk',
      platformMax: 2,
      userTarget: 380,
    });
    expect(r.multiplier).toBe(MANUAL_CUE_CLAMP);
    expect(r.effectiveWpm).toBeCloseTo(285, 6); // clamped but still past 275
    expect(r.mode).toBe('warning');
    expect(r.reason).toBe('above-zone');
  });

  it('stays in recommend mode when the effective rate sits in the safe zone', () => {
    const r = asr(200, 2, 270);
    expect(r.effectiveWpm).toBeCloseTo(270, 6); // below the 275 ceiling
    expect(r.mode).toBe('recommend');
    expect(r.reason).toBeNull();
  });
});

describe('recommend — pause-diluted articulatory warning (asr-word tier)', () => {
  // Full-payload anchors from scripts/data/web-rerun/rerun-results.jsonl:
  // iG9CE55wbtY pauseBias −75.2% (wordAccurateRate 312.8), Ks-_Mh1QhMc
  // −25.0% (242.6), arj7oStGLkU −57.5% (268.7). The fixtures hold the
  // first 20 events, so absolute numbers differ from the full payload;
  // the fire/no-fire polarity holds. wordTierInputs is the exact helper
  // entrypoints/content.ts feeds recommend() from (production path).
  function inputFrom(fixture: string): RecommendInput {
    const parsed = parseYouTubeJson3(readFixture(fixture));
    const naturalRate = filteredTokensOverTrimmedSpan(parsed.cues);
    const wordInputs = wordTierInputs(parsed.words, parsed.cues);
    if (naturalRate === null || wordInputs === null) {
      throw new Error(`${fixture}: rate or speech duration not measurable`);
    }
    return {
      naturalRate,
      tier: 'asr-word',
      contentType: 'talk',
      platformMax: 2,
      ...wordInputs,
    };
  }

  it('warns on the pause-heavy iG9CE55wbtY opening at the default target', () => {
    for (const fixture of [
      'real/asr-word.json',
      'real/windows-asr-iG9CE55wbtY-trunc.json',
    ]) {
      const r = recommend(inputFrom(fixture));
      expect(r.mode).toBe('warning');
      expect(r.reason).toBe('pause-diluted');
      expect(r.label).not.toContain('capped');
    }
  });

  it('stays in recommend mode on low-pause openings (Ks-_Mh1QhMc, arj7oStGLkU)', () => {
    for (const fixture of [
      'real/windows-asr-Ks-_Mh1QhMc-trunc.json',
      'real/windows-asr-arj7oStGLkU-trunc.json',
    ]) {
      const r = recommend(inputFrom(fixture));
      expect(r.mode).toBe('recommend');
      expect(r.reason).toBeNull();
    }
  });

  it('keeps the fixture word-timing coverage inside the measured band', () => {
    // Phase-0 band: 67.9–87.4% of text tokens timed (mean 83.6%). Sparse
    // coverage would misestimate speechDur; these anchors stay in-band.
    for (const fixture of [
      'real/asr-word.json',
      'real/windows-asr-iG9CE55wbtY-trunc.json',
      'real/windows-asr-Ks-_Mh1QhMc-trunc.json',
      'real/windows-asr-arj7oStGLkU-trunc.json',
    ]) {
      const parsed = parseYouTubeJson3(readFixture(fixture));
      const coverage = totalWords(parsed.words) / totalWords(parsed.cues);
      expect(coverage).toBeGreaterThanOrEqual(0.67);
      expect(coverage).toBeLessThanOrEqual(0.88);
    }
  });

  it('skips the warning when word-timing coverage is inadequate', () => {
    const r = recommend({
      naturalRate: 160,
      tier: 'asr-word',
      contentType: 'talk',
      platformMax: 2,
      articulatoryWpm: 800,
      timingCoverageOk: false,
    });
    expect(r.mode).toBe('recommend');
    expect(r.reason).toBeNull();
  });

  it('stays silent without an articulatory input (other tiers, older callers)', () => {
    for (const tier of ['asr-cue', 'manual-cue', 'estimated'] as const) {
      const r = recommend({
        naturalRate: 200, // clamp-free: 1.25x on every tier, effective 250
        tier,
        contentType: 'talk',
        platformMax: 2,
        articulatoryWpm: 800,
        timingCoverageOk: true,
      });
      expect(r.reason).toBeNull();
    }
    const bare = recommend({ naturalRate: 160, tier: 'asr-word', contentType: 'talk', platformMax: 2 });
    expect(bare.mode).toBe('recommend');
  });

  it('above-zone outranks pause-diluted when both fire', () => {
    const r = recommend({
      naturalRate: 140,
      tier: 'asr-word',
      contentType: 'talk',
      platformMax: 2,
      userTarget: 280,
      articulatoryWpm: 300,
      timingCoverageOk: true,
    });
    // effective 280 > 275 (above-zone); 2.0 × 300 = 600 > 393 (would be pause-diluted)
    expect(r.reason).toBe('above-zone');
  });

  it('pause-diluted outranks capped-below when both fire', () => {
    const r = recommend({
      naturalRate: 480,
      tier: 'asr-word',
      contentType: 'talk',
      platformMax: 2,
      articulatoryWpm: 800,
      timingCoverageOk: true,
    });
    // floor 0.5 → effective 240 < target (would be capped-below);
    // 0.5 × 800 = 400 > 393 (pause-diluted)
    expect(r.reason).toBe('pause-diluted');
  });
});

describe('recommend — unreachable and music', () => {
  it('reports the safe zone unreachable when platform max cannot reach it', () => {
    const r = asr(85.17); // real Faded fixture rate
    expect(r.multiplier).toBe(2);
    expect(r.effectiveWpm).toBeCloseTo(170.34, 2);
    expect(r.mode).toBe('unreachable');
    expect(r.label).toContain('safe zone unreachable');
  });

  it('uses the platform max in the unreachable path', () => {
    const r = asr(128, 1.5);
    expect(r.mode).toBe('unreachable');
    expect(r.multiplier).toBe(1.5);
    expect(r.effectiveWpm).toBeCloseTo(192, 6);
  });

  it('returns music mode without recommending a speed', () => {
    const r = recommend({
      naturalRate: 38,
      tier: 'asr-word',
      contentType: 'music',
      platformMax: 2,
    });
    expect(r.mode).toBe('music');
    expect(r.multiplier).toBe(1);
    expect(r.effectiveWpm).toBe(38);
    expect(r.reason).toBeNull();
    expect(r.label).toBe('music — speed not recommended');
  });
});

describe('recommend — labels', () => {
  it('formats the pill label', () => {
    expect(asr(128).label).toBe('→ 1.95x ≈ 250 wpm');
  });

  it('maps every tier to its honest label', () => {
    const tiers: RateTier[] = ['asr-word', 'asr-cue', 'manual-cue', 'estimated'];
    const expected = ['from captions', 'from captions', 'from captions (corrected)', 'estimated'];
    tiers.forEach((tier, i) => {
      const r = recommend({ naturalRate: 200, tier, contentType: 'talk', platformMax: 2 });
      expect(r.tierLabel).toBe(expected[i]);
    });
  });
});

describe('recommend — language-aware targets', () => {
  it('ja: mora target 380 — a 200 mora/min track recommends ~1.9x', () => {
    const r = recommend({
      naturalRate: 200,
      tier: 'asr-cue',
      contentType: 'lecture',
      platformMax: 2,
      language: LANGUAGES['ja'],
    });
    expect(r.multiplier).toBeCloseTo(1.9, 6); // 380/200
    expect(r.mode).toBe('recommend');
    expect(r.label).toContain('≈ 380 morae/min');
  });

  it('de: compounding factor — a 125 wpm track recommends ~1.4x', () => {
    const r = recommend({
      naturalRate: 125,
      tier: 'asr-cue',
      contentType: 'lecture',
      platformMax: 2,
      language: LANGUAGES['de'],
    });
    expect(r.multiplier).toBeCloseTo(1.4, 6); // 175/125
    expect(r.label).toContain('≈ 175 wpm');
  });

  it('uses the language ceiling for the above-zone warning', () => {
    const r = recommend({
      naturalRate: 160,
      tier: 'asr-cue',
      contentType: 'lecture',
      platformMax: 2,
      userTarget: 190,
      language: LANGUAGES['es'],
    });
    // 160 × 1.2 = 192 > es ceiling 175
    expect(r.mode).toBe('warning');
    expect(r.reason).toBe('above-zone');
  });

  it('scales the articulatory ceiling with the language ceiling', () => {
    const r = recommend({
      naturalRate: 160,
      tier: 'asr-word',
      contentType: 'lecture',
      platformMax: 2,
      language: LANGUAGES['ru'],
      articulatoryWpm: 300,
      timingCoverageOk: true,
    });
    // 1.05 × 300 = 315 > 185 / 0.7 ≈ 264; effective 168 ≤ 185, so the
    // pause-diluted warning fires, not above-zone.
    expect(r.reason).toBe('pause-diluted');
    expect(r.mode).toBe('warning');
  });

  it('labels syllable-unit recommendations syl/min', () => {
    const r = recommend({
      naturalRate: 200,
      tier: 'asr-cue',
      contentType: 'lecture',
      platformMax: 2,
      language: LANGUAGES['ko'],
    });
    expect(r.label).toContain('≈ 340 syl/min');
  });

  it('uses the unit in the unreachable label', () => {
    const r = recommend({
      naturalRate: 100,
      tier: 'asr-cue',
      contentType: 'lecture',
      platformMax: 2,
      language: LANGUAGES['ja'],
    });
    expect(r.mode).toBe('unreachable');
    expect(r.label).toContain('≈ 200 morae/min');
  });

  it('userTarget overrides the language target', () => {
    const r = recommend({
      naturalRate: 200,
      tier: 'asr-cue',
      contentType: 'lecture',
      platformMax: 2,
      userTarget: 300,
      language: LANGUAGES['fr'],
    });
    expect(r.multiplier).toBeCloseTo(1.5, 6); // 300/200
  });

  it('defaults to the English target without a language', () => {
    const r = asr(200);
    expect(r.label).toContain('≈ 250 wpm');
  });
});
