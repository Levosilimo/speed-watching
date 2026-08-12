// vtt.js (Mozilla's WebVTT implementation, Apache-2.0) ships no type
// declarations; this is the subset lib/captions-harvest.ts uses. The module
// is CommonJS (module.exports = { WebVTT, VTTCue, VTTRegion }); consumers
// import it as a default and destructure, which works under vite bundling,
// vitest, and node's ESM loader alike.
declare module 'vtt.js' {
  export class VTTCue {
    constructor(startTime: number, endTime: number, text: string);
    startTime: number;
    endTime: number;
    text: string;
  }

  export class StringDecoder {
    decode(data?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }): string;
  }

  export class Parser {
    constructor(host: unknown, decoder: StringDecoder);
    oncue?: (cue: VTTCue) => void;
    parse(data?: string): void;
    flush(): void;
  }

  export const WebVTT: {
    Parser: typeof Parser;
    StringDecoder: typeof StringDecoder;
  };

  const vttjs: {
    WebVTT: typeof WebVTT;
    VTTCue: typeof VTTCue;
    VTTRegion: unknown;
  };
  export default vttjs;
}
