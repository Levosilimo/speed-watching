// Wave 3 batch B — the buffer soak: MANY synthetic capture payloads
// streamed through a real TimedtextBuffer + pickWordTimed. (a) pickWordTimed
// always returns the largest word-timed body among those added (its
// contract); (b) growth stays bounded per video — the Wave-2 finding
// (add appends without bound, pruned only by clear(videoId)) is pinned
// here as the bounded-per-video contract.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_CAPTURES_PER_VIDEO, TimedtextBuffer, type CapturedTimedtext } from '../lib/caption-capture';

const SEED = 4242;

/** A synthetic signed timedtext response — the shape installCaptionCapture
 * delivers to the buffer. */
function capture(body: string): CapturedTimedtext {
  return { url: 'https://youtube.com/api/timedtext?lang=en', httpStatus: 200, body };
}

/** Word-timed json3 body: non-empty top-level windows (isWordTimed). The
 * pad scales the body length, the pick's completeness proxy. */
function wordTimedBody(pad: number): string {
  return JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'x'.repeat(pad) }] }],
    windows: [{ wpWinStartMs: 0, wWinOffsetMs: 0, segs: [{ utf8: 'x'.repeat(pad), tOffsetMs: 0 }] }],
  });
}

/** Cue-only json3 body: no windows, no tOffsetMs segs — never word-timed,
 * no matter how large. */
function cueOnlyBody(pad: number): string {
  return JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'x'.repeat(pad) }] }],
    windows: [],
  });
}

describe('TimedtextBuffer soak', () => {
  it('pickWordTimed always returns the largest word-timed body among those added', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            pad: fc.integer({ min: 1, max: 2000 }),
            wordTimed: fc.boolean(),
          }),
          { minLength: 1, maxLength: 300 },
        ),
        (specs) => {
          const buffer = new TimedtextBuffer();
          for (const spec of specs) {
            buffer.add('v1', capture(spec.wordTimed ? wordTimedBody(spec.pad) : cueOnlyBody(spec.pad)));
          }
          const timed = specs.filter((spec) => spec.wordTimed);
          if (timed.length === 0) {
            expect(buffer.pickWordTimed('v1')).toBeNull();
            return;
          }
          const largest = Math.max(...timed.map((spec) => wordTimedBody(spec.pad).length));
          const pick = buffer.pickWordTimed('v1');
          expect(pick).not.toBeNull();
          expect(pick!.body.length).toBe(largest);
        },
      ),
      { seed: SEED, numRuns: 50 },
    );
  });

  it('keeps per-video growth bounded under a long capture stream', () => {
    // The Wave-2 finding: add() appended without bound, pruned only by
    // clear(videoId) at video change — a long session grew the list
    // forever. The soak pins the bounded-per-video contract: overflow
    // evicts, and the pick still lands the largest word-timed body.
    const buffer = new TimedtextBuffer();
    for (let i = 0; i < 500; i++) {
      buffer.add('v1', capture(i % 3 === 0 ? wordTimedBody(i + 1) : cueOnlyBody(i + 1)));
    }
    expect(buffer.size('v1')).toBeLessThanOrEqual(MAX_CAPTURES_PER_VIDEO);
    // The largest word-timed body added (i = 498, the last multiple of 3)
    // survives the eviction pressure.
    expect(buffer.pickWordTimed('v1')!.body.length).toBe(wordTimedBody(499).length);
  });

  it('keeps the largest word-timed body even when every capture is word-timed', () => {
    const buffer = new TimedtextBuffer();
    for (let i = 0; i < MAX_CAPTURES_PER_VIDEO + 10; i++) {
      buffer.add('v1', capture(wordTimedBody(i + 1)));
    }
    expect(buffer.pickWordTimed('v1')!.body.length).toBe(wordTimedBody(MAX_CAPTURES_PER_VIDEO + 10).length);
  });

  it('isolates growth per video and resets on clear(videoId)', () => {
    const buffer = new TimedtextBuffer();
    for (let i = 0; i < 100; i++) buffer.add('v1', capture(cueOnlyBody(i)));
    for (let i = 0; i < 5; i++) buffer.add('v2', capture(cueOnlyBody(i)));
    expect(buffer.size('v1')).toBeLessThanOrEqual(MAX_CAPTURES_PER_VIDEO);
    expect(buffer.size('v2')).toBe(5);
    buffer.clear('v1');
    expect(buffer.size('v1')).toBe(0);
    expect(buffer.pickWordTimed('v1')).toBeNull();
    // Captures with no word-timed body never resolve the pick.
    expect(buffer.pickWordTimed('v2')).toBeNull();
  });
});
