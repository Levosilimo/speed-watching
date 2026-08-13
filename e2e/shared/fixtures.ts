// Fixture metadata shared by the fixture server (e2e/server.ts) and the
// browser-agnostic specs (e2e/shared/specs.ts).

/** Fixture file → caption track kind; absent kind means a manual track. */
export const KIND_BY_FIXTURE: Record<string, string | undefined> = {
  'real/asr-word.json': 'asr',
  'synthetic/word-level.json': 'asr',
  'synthetic/music-lyrics.json': 'asr',
  'real/manual-cue.json': undefined,
  'synthetic/cue-level-only.json': undefined,
  'synthetic/ja-captions.json': 'asr',
};

/**
 * Fixture file → caption-track languageCode; absent means 'en'. The ja
 * fixture exercises the language-resolution chain (resolveLanguage →
 * recommend → unit label) end-to-end in both browser suites.
 */
export const LANG_BY_FIXTURE: Record<string, string | undefined> = {
  'synthetic/ja-captions.json': 'ja',
};

/**
 * Fixtures whose caption payload the server refuses (403). The content
 * script's WEB fetch fails and the ANDROID innertube fallback must fire;
 * the file itself never needs to exist.
 */
export const BLOCKED_FIXTURES = ['synthetic/web-blocked.json'];

/**
 * Fixtures served as a watch page with no caption tracks at all — the
 * content script must fall back to the 'estimated' heuristic tier.
 */
export const NO_TRACK_FIXTURES = ['synthetic/no-tracks.json'];
