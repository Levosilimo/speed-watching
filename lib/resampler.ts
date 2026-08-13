// Pure resampling math for the STT recorder: decimates any native sample
// rate down to TARGET_RATE (16 kHz mono) with linear interpolation. No
// audio APIs — runs in the AudioWorklet, the offscreen document, and vitest.

export const TARGET_RATE = 16000;

function downmix(left: Float32Array, right: Float32Array): Float32Array {
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    // Indices are in-bounds by the loop; ?? satisfies noUncheckedIndexedAccess.
    out[i] = (left[i] ?? 0) / 2 + (right[i] ?? 0) / 2;
  }
  return out;
}

// Stateful decimator. Input blocks may be any length and arrive in any
// order; position/framesSeen/prevFrame carry across blocks so a stream
// split into blocks resamples exactly like one long buffer (no drift).
export class Resampler {
  // Fractional position of the next output sample, in input-frame units
  // relative to the start of the stream.
  private position = 0;
  // Total input frames consumed so far (absolute stream position).
  private framesSeen = 0;
  // Last mono frame of the previous block; interpolation across a block
  // boundary reads it instead of a frame that does not exist yet.
  private prevFrame = 0;
  private readonly step: number;

  constructor(inputRate: number, targetRate: number = TARGET_RATE) {
    this.step = inputRate / targetRate;
  }

  /** Appends one block of planar input (mono, or stereo when channel1 is
   * given) at the native rate and returns the 16 kHz mono samples it maps
   * to. An output sample is emitted only once both frames it interpolates
   * between exist, so the last sample of a block may be emitted by the next
   * call — position carries over, nothing is lost. */
  process(channel0: Float32Array, channel1?: Float32Array): Float32Array {
    const frames = channel0.length;
    if (frames === 0) return new Float32Array(0);
    const mono = channel1 === undefined ? channel0 : downmix(channel0, channel1);
    const at = (index: number): number => mono[index] ?? 0;
    const end = this.framesSeen + frames;
    const out: number[] = [];
    while (Math.floor(this.position) < end - 1) {
      const i = Math.floor(this.position);
      const t = this.position - i;
      const x0 = i < this.framesSeen ? this.prevFrame : at(i - this.framesSeen);
      const x1 = at(i + 1 - this.framesSeen);
      out.push(x0 + (x1 - x0) * t);
      this.position += this.step;
    }
    this.prevFrame = at(frames - 1);
    this.framesSeen = end;
    return Float32Array.from(out);
  }
}
