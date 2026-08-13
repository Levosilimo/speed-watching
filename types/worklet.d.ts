// lib.dom models AudioWorkletNode but not the processor scope; these are
// the AudioWorkletGlobalScope members lib/recorder-worklet.ts uses.
interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void;

declare const sampleRate: number;
