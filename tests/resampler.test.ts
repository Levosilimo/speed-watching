import { describe, expect, it } from 'vitest';
import { Resampler, TARGET_RATE } from '../lib/resampler';

describe('TARGET_RATE', () => {
  it('is the 16 kHz Whisper input rate', () => {
    expect(TARGET_RATE).toBe(16000);
  });
});

describe('Resampler: 48 kHz → 16 kHz (3:1 decimation)', () => {
  it('picks every third frame exactly — integer positions skip interpolation', () => {
    const resampler = new Resampler(48000);
    // Output sample n sits at input position 3n: frames 0 and 3.
    expect(Array.from(resampler.process(new Float32Array([0, 1, 2, 3, 4, 5])))).toEqual([0, 3]);
    expect(Array.from(resampler.process(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])))).toEqual([
      0, 3, 6,
    ]);
  });

  it('downmixes stereo to mono before resampling', () => {
    const resampler = new Resampler(48000);
    // Mono frames are the channel averages: [1, 2, 3, 4, 5, 6]; every third: 1, 4.
    const left = new Float32Array([0, 1, 2, 3, 4, 5]);
    const right = new Float32Array([2, 3, 4, 5, 6, 7]);
    expect(Array.from(resampler.process(left, right))).toEqual([1, 4]);
  });
});

describe('Resampler: 44.1 kHz → 16 kHz (step 2.75625, fractional positions)', () => {
  it('linearly interpolates between the frames around each output position', () => {
    const resampler = new Resampler(44100);
    // Sample 0 at position 0 → frame 0. Sample 1 at position 2.75625:
    // frames 2 and 3 with t = 0.75625 → 2 + 1·0.75625.
    const out = resampler.process(new Float32Array([0, 1, 2, 3]));
    expect(out).toHaveLength(2);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(2.75625, 5);
  });

  it('interpolates across a block boundary using the previous block tail', () => {
    // Block 1 of 3 frames emits only sample 0 (position 2.75625 needs frame
    // 3, which does not exist yet). Block 2's first output interpolates from
    // the previous block's last frame to its own first frame.
    const twoBlocks = new Resampler(44100);
    const first = twoBlocks.process(new Float32Array([0, 1, 2]));
    expect(Array.from(first)).toEqual([0]);
    const second = twoBlocks.process(new Float32Array([3, 4, 5]));
    expect(second).toHaveLength(1);
    expect(second[0]).toBeCloseTo(2.75625, 5); // 2 + (3 − 2)·0.75625
  });

  it('splitting a stream into blocks matches one continuous buffer exactly', () => {
    const continuous = new Resampler(44100);
    const whole = continuous.process(new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]));

    const split = new Resampler(44100);
    const blocks = split.process(new Float32Array([0, 1, 2, 3, 4, 5, 6]));
    const blocksRest = split.process(new Float32Array([7, 8, 9, 10, 11, 12, 13]));

    expect(Array.from(blocks).concat(Array.from(blocksRest))).toEqual(Array.from(whole));
  });

  it('does not drift across 100 blocks: 44100 frames in yield exactly 16000 samples out', () => {
    const blockSize = 441;
    const blocks = 100;
    const resampler = new Resampler(44100);
    const out: number[] = [];
    for (let b = 0; b < blocks; b++) {
      const block = Float32Array.from({ length: blockSize }, (_, i) => b * blockSize + i);
      out.push(...resampler.process(block));
    }
    expect(out).toHaveLength(16000);
    // A unit ramp is reproduced exactly by lerp: output n ≈ n·2.75625.
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[100]).toBeCloseTo(100 * 2.75625, 3);
    // Float32 stores 44097.24 with ulp 2⁻⁸, so the tolerance covers rounding.
    expect(out[15999]).toBeCloseTo(15999 * 2.75625, 2);
  });
});

describe('Resampler: other rates and edge blocks', () => {
  it('upsamples below the target rate (8 kHz → 16 kHz, step 0.5)', () => {
    const resampler = new Resampler(8000);
    // Positions 0 and 0.5: frame 0, then the midpoint of frames 0 and 10.
    expect(Array.from(resampler.process(new Float32Array([0, 10])))).toEqual([0, 5]);
  });

  it('ignores empty blocks without touching stream state', () => {
    const resampler = new Resampler(44100);
    expect(resampler.process(new Float32Array(0))).toHaveLength(0);
    expect(Array.from(resampler.process(new Float32Array([0, 1, 2])))).toEqual([0]);
  });

  it('single-frame blocks still emit cross-boundary samples', () => {
    const resampler = new Resampler(44100);
    expect(resampler.process(new Float32Array([0]))).toHaveLength(0);
    // Position 2.75625 now points at the block seam: prevFrame 0 → frame 1.
    expect(Array.from(resampler.process(new Float32Array([1])))).toEqual([0]);
  });
});
