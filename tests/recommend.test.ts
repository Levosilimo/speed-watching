import { describe, expect, it } from 'vitest';
import type { RecommendInput, Recommendation } from '../lib/recommend';
import {
  MANUAL_CUE_CLAMP,
  ROUNDING_STEP,
  SAFE_ZONE_CEILING_WPM,
  SLOW_DOWN_FLOOR,
  TARGET_WPM,
  TIER_LABELS,
  recommend,
} from '../lib/recommend';
import type { RateTier } from '../lib/recommend';

const asr = (naturalRate: number, platformMax = 2, userTarget?: number) =>
  recommend({ naturalRate, tier: 'asr-cue', contentType: 'lecture', platformMax, userTarget });

describe('recommend — constants', () => {
  it('pins the engine constants', () => {
    expect(TARGET_WPM).toBe(250);
    expect(SAFE_ZONE_CEILING_WPM).toBe(275);
    expect(ROUNDING_STEP).toBe(0.05);
    expect(MANUAL_CUE_CLAMP).toBe(1.5);
    expect(SLOW_DOWN_FLOOR).toBe(0.5);
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
