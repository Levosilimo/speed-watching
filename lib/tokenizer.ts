// Letter/digit-only token counting. YouTube ASR injects bracket markers
// ([Music], [Applause]) and note symbols (♪) into transcripts; whitespace
// splitting counts those as words and inflates every rate.

const WORD_RUN_RE = /[\p{L}\p{N}]+/gu;

/** Maximal runs of letters and digits; every other character splits tokens. */
export function countWordTokens(text: string): number {
  return text.match(WORD_RUN_RE)?.length ?? 0;
}

/** True when the text is only bracket markers like [Music], whitespace tolerated. */
export function isBracketMarker(text: string): boolean {
  return /^\s*(?:\[[^\]]*\]\s*)+$/.test(text);
}

export function hasNoteSymbol(text: string): boolean {
  return /[♪♫]/.test(text);
}
