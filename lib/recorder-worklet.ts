// AudioWorklet processor for the STT recorder: resamples the capture
// stream from the context's native rate down to 16 kHz mono and posts the
// result to the recorder's ring buffer. Bundled by vite through the
// `?worker&url` import in entrypoints/offscreen/main.ts, so it may use
// normal imports (the Resampler is inlined into the bundle).
import { RECORDER_PROCESSOR } from './audio-recorder';
import { Resampler, TARGET_RATE } from './resampler';

// Post size: ~64 ms of 16 kHz audio per message, transferred zero-copy.
const POST_CHUNK_SAMPLES = 1024;

class ResamplerProcessor implements AudioWorkletProcessor {
  declare readonly port: MessagePort;
  private readonly resampler = new Resampler(sampleRate, TARGET_RATE);
  private pending: Float32Array[] = [];
  private pendingLength = 0;

  process(inputs: Float32Array[][], _outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input === undefined || input[0] === undefined || input[0].length === 0) {
      return true;
    }
    // The recorder forces channelCount 2 ('explicit'), so channel 1 is
    // always present; the optional parameter covers any direct use.
    this.push(this.resampler.process(input[0], input[1]));
    return true;
  }

  private push(samples: Float32Array): void {
    if (samples.length === 0) return;
    this.pending.push(samples);
    this.pendingLength += samples.length;
    if (this.pendingLength < POST_CHUNK_SAMPLES) return;
    const out = new Float32Array(this.pendingLength);
    let offset = 0;
    for (const part of this.pending) {
      out.set(part, offset);
      offset += part.length;
    }
    this.pending = [];
    this.pendingLength = 0;
    this.port.postMessage(out, [out.buffer]);
  }
}

registerProcessor(RECORDER_PROCESSOR, ResamplerProcessor);
