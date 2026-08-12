// Deterministic property tests (fixed seed per property) over the pure lib
// modules. fast-check replays the same pseudo-random walk on every run, so a
// regression shows up as a failing run, not a flaky one.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Segment } from '../lib/captions';
import { detectMusic, type ContentType } from '../lib/music';
import { RateReapplier, type VideoLike } from '../lib/matcher';
import { OverrideLog } from '../lib/override-log';
import { recommend } from '../lib/recommend';
import {
  correctedCueLevelWpm,
  cueLevelWpm,
  filteredTokensOverTrimmedSpan,
  manualCueRate,
  wordLevelWpm,
} from '../lib/wpm';
import { mockStorage } from './fixtures/helpers';

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

const tierArb = fc.constantFrom('asr-word', 'asr-cue', 'manual-cue', 'estimated');
const speechTypeArb = fc.constantFrom(
  'lecture',
  'talk',
  'explainer',
  'news',
  'podcast',
  'generic',
  'unknown',
);

function sortedPair(arb: fc.Arbitrary<number>): fc.Arbitrary<[number, number]> {
  return fc.tuple(arb, arb).map(([a, b]) => (a <= b ? [a, b] : [b, a]));
}

describe('recommend properties', () => {
  it('returns a non-increasing multiplier as the natural rate rises', () => {
    fc.assert(
      fc.property(
        sortedPair(fc.double({ min: 20, max: 400, noNaN: true })),
        tierArb,
        fc.constantFrom('lecture', 'talk', 'explainer', 'news', 'podcast', 'music', 'generic', 'unknown'),
        fc.double({ min: 1, max: 2.5, noNaN: true }),
        ([low, high], tier, contentType, platformMax) => {
          const slow = recommend({ naturalRate: low, tier, contentType, platformMax });
          const fast = recommend({ naturalRate: high, tier, contentType, platformMax });
          expect(fast.multiplier).toBeLessThanOrEqual(slow.multiplier + 1e-9);
          expect(fast.multiplier).toBeGreaterThanOrEqual(0);
          expect(fast.multiplier).toBeLessThanOrEqual(platformMax + 1e-9);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('keeps unclamped recommendations on the exact rounded multiplier', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 20, max: 400, noNaN: true }),
        tierArb,
        speechTypeArb,
        fc.double({ min: 1, max: 2.5, noNaN: true }),
        fc.option(fc.integer({ min: 150, max: 400 }), { nil: undefined }),
        (naturalRate, tier, contentType, platformMax, userTarget) => {
          const rec = recommend({ naturalRate, tier, contentType, platformMax, userTarget });
          if (rec.mode !== 'recommend') return;
          const target = userTarget ?? 250;
          const rounded = Math.round((target / naturalRate) / 0.05) * 0.05;
          // Clamped recommendations (floor 0.5, platformMax, manual-cue 1.5)
          // land off the rounded value, so only assert the rounding path.
          if (rounded < 0.5 - 1e-9 || rounded > platformMax + 1e-9) return;
          if (tier === 'manual-cue' && rounded > 1.5 + 1e-9) return;
          expect(Math.abs(rec.multiplier - rounded)).toBeLessThan(1e-9);
          // Rounding error is at most half a step of naturalRate.
          expect(Math.abs(rec.effectiveWpm - target)).toBeLessThanOrEqual(naturalRate * 0.025 + 1e-9);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });
});

describe('wpm rate properties', () => {
  it('scales cue timings inversely: rate(cues × k) = rate(cues) / k', () => {
    fc.assert(
      fc.property(cuesArb, fc.double({ min: 0.5, max: 2, noNaN: true }), (cues, k) => {
        const scaled = cues.map((cue) => ({
          ...cue,
          startSec: cue.startSec * k,
          durSec: cue.durSec === undefined ? undefined : cue.durSec * k,
        }));
        for (const rate of [wordLevelWpm, cueLevelWpm, correctedCueLevelWpm, manualCueRate, filteredTokensOverTrimmedSpan]) {
          const before = rate(cues);
          if (before === null) continue;
          const after = rate(scaled);
          expect(after).not.toBeNull();
          expect(after!).toBeCloseTo(before / k, 9);
        }
      }),
      { seed: SEED, numRuns: 100 },
    );
  });
});

describe('detectMusic properties', () => {
  it('is stable across repeated calls and monotone in the rate cap', () => {
    fc.assert(
      fc.property(cuesArb, sortedPair(fc.double({ min: 0, max: 300, noNaN: true })), (cues, [low, high]) => {
        const atLow = detectMusic(cues, low);
        expect(detectMusic(cues, low)).toBe(atLow); // deterministic, no hidden state
        if (detectMusic(cues, high)) expect(atLow).toBe(true);
      }),
      { seed: SEED, numRuns: 100 },
    );
  });
});

describe('RateReapplier invariants', () => {
  class FakeVideo implements VideoLike {
    playbackRate = 1;
    paused = false;
    isConnected = true;
    private readonly listeners = new Set<EventListener>();

    addEventListener(type: string, listener: EventListener): void {
      this.listeners.add(listener);
    }

    removeEventListener(type: string, listener: EventListener): void {
      this.listeners.delete(listener);
    }

    fire(): void {
      for (const listener of this.listeners) listener(new Event('ratechange'));
    }
  }

  it('applies the clamped multiplier, then only re-asserts a reset to 1.0', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.5, max: 2.5, noNaN: true }),
        fc.double({ min: 0.5, max: 2.5, noNaN: true }),
        fc.double({ min: 1, max: 3, noNaN: true }),
        (multiplier, manualRate, platformMax) => {
          const video = new FakeVideo();
          const loop = new RateReapplier();
          loop.start(video, multiplier, platformMax);
          const clamped = Math.min(multiplier, platformMax);
          expect(video.playbackRate).toBe(clamped);
          expect(loop.lastApplied).toBe(clamped);
          video.playbackRate = manualRate;
          video.fire();
          if (Math.abs(manualRate - 1) <= 1e-6) {
            expect(video.playbackRate).toBe(clamped);
          } else {
            expect(video.playbackRate).toBe(manualRate);
          }
          loop.stop();
          expect(loop.active).toBe(false);
        },
      ),
      { seed: SEED, numRuns: 100 },
    );
  });
});

describe('OverrideLog.report properties', () => {
  it('counts every entry but averages only applied multipliers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            contentType: fc.constantFrom('lecture', 'talk', 'generic'),
            multiplier: fc.double({ min: 0.5, max: 2, noNaN: true }),
            userAction: fc.constantFrom('apply', 'dismiss', 'adjust'),
          }),
          { minLength: 0, maxLength: 40 },
        ),
        async (specs) => {
          const log = new OverrideLog(mockStorage());
          for (const spec of specs) {
            await log.append({
              site: 'youtube.com',
              naturalRate: 150,
              mode: 'recommend',
              ...spec,
            });
          }
          const report = await log.report();
          expect(report.total).toBe(specs.length);
          const appliedByType = new Map<string, number[]>();
          for (const spec of specs) {
            const applied = appliedByType.get(spec.contentType) ?? [];
            if (spec.userAction === 'apply') applied.push(spec.multiplier);
            appliedByType.set(spec.contentType, applied);
          }
          for (const [type, applied] of appliedByType) {
            const stats = report.byContentType[type as ContentType];
            expect(stats?.count).toBe(specs.filter((s) => s.contentType === type).length);
            if (applied.length === 0) {
              expect(stats?.avgMultiplier).toBeNull();
            } else {
              const mean = applied.reduce((a, b) => a + b, 0) / applied.length;
              expect(stats?.avgMultiplier).toBeCloseTo(mean, 9);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 50 },
    );
  });
});
