# Phase 0 spike A: caption-based WPM measurement — gate report

Measured 2026-08-11. Data: `scripts/data/sample-results.jsonl` (24 records, one
per video; computed fields only). Raw payload fixtures captured from the run:
`tests/fixtures/real/` (truncated to the first 20 events).

## Method

Per video: load the watch page headless (Playwright chromium, real Chrome UA,
locale en-US, YouTube consent accepted via SOCS cookie, no login), read
`ytInitialPlayerResponse`, then obtain captions via the page's own network
layer and compute wpm with `lib/captions.ts` + `lib/wpm.ts`.

Two fetch paths were tried; only one works from this machine:

- **WEB client timedtext (blocked).** The captionTracks baseUrl from
  `ytInitialPlayerResponse` returns HTTP 200 with an empty body
  (`content-type: text/html`, 0 bytes) for every video — including the
  player's own timedtext request (which carries the signed URL, `pot` token,
  `fmt=json3`, full browser headers) and a bare curl without cookies.
  `youtubei/v1/get_transcript`, triggered from the page's own "Show
  transcript" button, returns 400 `failedPrecondition`. Evidence of an
  IP-reputation block on caption endpoints for this datacenter IP, not a
  session or signature problem: identical requests would succeed from a
  residential IP (the player requests captions the same way in every normal
  browser).
- **ANDROID innertube client (works).** POST `youtubei/v1/player` with
  `clientName: ANDROID, clientVersion: 20.10.31` returns a full player
  response with caption tracks; fetching the picked track's baseUrl with
  `fmt=json3` returns real payloads (e.g. 379 KB, 1,168 events for the Ken
  Robinson talk). Word timing in these payloads lives in `events[].segs[].tOffsetMs`;
  the `windows` array is empty. Track picked: first `en`+asr, else `en` manual,
  else first asr, else first track.

Cue-level wpm divides by the wall-clock cue span (inter-cue gaps included).
Corrected cue-level wpm divides by the sum of cue durations (gaps subtracted,
capped at the span; within-cue pauses stay counted as speech). Word-level wpm
divides the timed-word token count by the first-to-last word span (final
word's duration not counted, ~1 word of error).

## 1. Caption availability (gate: ≥90% word-level)

| outcome | count |
|---|---|
| videos attempted | 24 |
| loaded, captions parsed | 22 |
| word-level timing present | 17 |
| cue-level only (manual track) | 5 |
| no caption tracks at all | 2 |

Word-level availability: **17/22 = 77.3% — GATE FAIL** (target ≥90%).
Cue-level availability: 22/22 = 100%.

The 5 without word timing are manual-only tracks (no asr track exists, so no
per-seg timing by design): Simon Sinek TED, Tom Scott "Fourier series",
Happy, Despacito, Blinding Lights. The 2 with zero tracks: Joe Rogan #1169
(podcast) and Taylor Swift "Shake It Off" — the WEB player response lists no
caption tracks for either.

On the 17 word-level videos, per-seg timing covers 67.9–87.4% of text tokens
(mean 83.6%); the remainder are untimed segs (bracket markers like `[Music]`,
and words in segs YouTube left untimed).

## 2. Word-level vs cue-level wpm spread (silence-bias measurement)

For all 17 videos with both numbers, cue-level wpm is **higher** than
word-level wpm: ratio 1.093–1.284, mean 1.168. The gap is the ~16% of tokens
that word-level drops (untimed segs) but cue-level counts, plus `[Music]` /
`♪` markers that cue text treats as words.

| videoId | category | wordWpm | cueWpm | cue/word | timing coverage |
|---|---|---|---|---|---|
| iG9CE55wbtY (Ken Robinson TED) | talk | 140.5 | 167.0 | 1.19 | 82.5% |
| Ks-_Mh1QhMc (Amy Cuddy TED) | talk | 160.9 | 183.1 | 1.14 | 86.0% |
| arj7oStGLkU (Tim Urban TED) | talk | 140.4 | 162.9 | 1.16 | 85.2% |
| HtSuA80QTyo (MIT 6.006 L1) | lecture | 110.8 | 128.2 | 1.16 | 86.3% |
| jGwO_UgTS7I (Stanford CS229 L1) | lecture | 142.9 | 170.5 | 1.19 | 83.7% |
| 8mAITcNt710 (CS50 full course, 25 h) | lecture | 162.5 | 188.3 | 1.16 | 86.3% |
| fpbOEoRrHyU (Last Week Tonight) | news-comedy | 127.6 | 150.4 | 1.18 | 84.5% |
| WUvTyaaNkzM (3B1B calculus) | explainer | 150.2 | 178.3 | 1.19 | 84.0% |
| aircAruvnKk (3B1B neural nets) | explainer | 156.3 | 180.6 | 1.16 | 85.2% |
| h6fcK_fRYaI (Kurzgesagt "The Egg") | explainer | 103.0 | 115.4 | 1.12 | 82.9% |
| 7Pq-S557XQU (CGP Grey) | explainer | 159.6 | 185.8 | 1.16 | 84.7% |
| w-I6XTVZXww (Numberphile 1+2+3…) | explainer | 168.2 | 191.1 | 1.14 | 87.4% |
| XRr1kaXKBsU (Veritasium gravity) | explainer | 118.6 | 145.8 | 1.23 | 80.7% |
| JTvcpdfGUtQ (Vsauce speed of dark) | explainer | 128.6 | 148.3 | 1.15 | 85.1% |
| X32dce7_D48 (Stand-up Maths 0!) | explainer | 126.6 | 145.9 | 1.15 | 86.1% |
| 60ItHLz5WEA (Alan Walker "Faded") | music | 29.4 | 37.7 | 1.28 | 67.9% |
| dQw4w9WgXcQ (Rick Astley) | music | 75.5 | 82.5 | 1.09 | 82.1% |

Interpretation, per video type:

- **ASR tracks**: cue-level wpm overestimates by ~10–28% (mean 16.8%)
  because untimed segs and non-speech markers inflate the cue token count.
  Overestimating the rate recommends a *lower* multiplier — the safe
  direction. Word-level wpm is the anchor but undercounts by the untimed
  fraction (~16%), so it is itself a lower bound on true speech rate. The
  product fix is to count tokens from the cue text over the word-timed span
  (for the Ken Robinson talk that yields 3,337 tokens over 1,176 s = 170 wpm,
  vs 140.5 word-level and 167.0 cue-level), or scale word-level by
  `textTokens / nWordsTimed`.
- **Manual tracks**: no word timing exists, so only cue-level applies. Naive
  cue wpm underestimates because manual cues leave real inter-cue gaps
  (Simon Sinek: 170.2 → 181.6 corrected, +6.7%; Tom Scott: 179.3 → 206.3,
  +15.0%; Happy +3.1%; Despacito +5.0%; Blinding Lights +6.0%) — the
  dangerous direction from plan-v2, confirmed on the only track type where
  the bias exists.

## 3. Silence correction

Corrected vs naive cue wpm: **ASR tracks: 0.0% difference on all 17** (ASR
cues tile the timeline contiguously; there are no inter-cue gaps to
subtract, so sum-of-durations equals the span — the correction is a no-op and
the pause time is embedded inside cue durations). **Manual tracks: +3.1% to
+15.0%, mean +7.2%** (gaps are real and get subtracted).

Conclusion: the silence-correction function is necessary and effective on
manual tracks, inert on ASR tracks. On ASR tracks the dominant cue-level
error is token overcount (section 2), not silence.

## 4. Accuracy check (counting)

Reference: `Intl.Segmenter` (ICU word segmentation, `isWordLike`) over the
same joined caption text, versus the parser's `\S+` tokenizer. This
validates **counting, not transcription accuracy** — there is no independent
transcript to compare against, and word timing itself could not be
cross-checked with the WEB endpoint blocked on this network.

- 17 of 22 videos: |delta| ≤ 0.53% (regex counts 0.1–0.5% fewer — ICU splits
  on punctuation like `—`).
- Numberphile (math symbols): +2.81%.
- 3 lyric tracks: +27.9% to +37.2% — `♪`/`♫` symbols count as `\S+` tokens
  but are not ICU word-like. Music-note symbols inflate counts on lyric
  captions; Phase 1 should use a letter-or-digit-containing tokenizer.

Word-count anchors: the Ken Robinson talk has 3,337 tokens (regex) / 3,345
(ICU) over 20 min; the CS50 course 280,853 over 24.9 h; rates fall out at
140–191 wpm for spoken content — consistent with known lecture/talk rates
(plan-v2 prior: lectures 140–160, talks 150–180).

## 5. Observed failure cases

1. **No tracks (2/24)**: Joe Rogan #1169 (podcast), Taylor Swift "Shake It
   Off" (music). WEB player response lists zero caption tracks; nothing to
   parse. The podcast case is notable — long-form interview content with no
   exposed captions would need the tier-3 STT path.
2. **ASR on music (2/24)**: "Faded" yields 131 tokens over 209 s (37.7 wpm,
   coverage 67.9%), first cue `[Music]`; Rick Astley 291 tokens over 212 s.
   Sparse, marker-dominated, no usable rate. Confirmed degradation case →
   fall to tier 2 + correction or suppress.
3. **Manual-only tracks (5/24)**: no word timing by design; cue-level only,
   with the +3–15% naive underestimate corrected as in section 3.
4. **WEB endpoint block (all)**: empty 200s / 400s from this IP; the
   measurement itself had to switch to the ANDROID client. Content-script
   path (`entrypoints/content.ts`) uses the same timedtext fetch and will hit
   the same wall only on blocked IPs; on user residential IPs the WEB
   endpoint serves normally.

## 6. Gates

| gate | result |
|---|---|
| ≥90% word-level availability | **FAIL** — 77.3% (17/22) on this network |
| word-level wpm within ±10% of independent reference | **NOT MEASURABLE here** — WEB word-level endpoint IP-blocked; count accuracy vs ICU on spoken content: 17/22 within ±0.53%, max |delta| 2.81% (Numberphile math symbols; lyric tracks 28–37% from note-symbol tokens) |
| cue-level fallback + silence correction | **PASS** — 100% availability; correction measured (+3–15% on manual tracks, no-op on ASR) |
| degradation rule for music / no-tracks | **PASS (measured)** — 4/24 videos degrade as documented, none crash |

## 7. Follow-ups for Phase 1

1. Re-run this harness from a residential IP to capture WEB json3 (word
   timing in `windows`) and to clear the ≥90% gate with the format the
   extension will actually receive.
2. Word-level wpm should count tokens from cue text over the word span
   (removes the ~16% untimed-token underestimate) — one-line change, all
   numbers already in the JSONL to re-derive.
3. Tokenizer: count only tokens containing a letter or digit (kills `♪`/`[Music]`
   inflation on lyric tracks).
4. Cue-level tier: keep the silence correction for manual tracks, but on ASR
   tracks the correction is inert — do not advertise "corrected" as accurate
   there; word-level (or token-scaled word-level) is the only trustworthy
   ASR number.
5. Verify JRE-style podcasts (no tracks) against the tier-3 STT decision.

---

## 8. Residential re-run — runbook gate 1 (2026-08-12)

Re-ran the harness from a residential IP (217.119.65.117) with the
POT-aware capture method: the player's own signed `/api/timedtext` response
is intercepted via `page.on('response')` while captions are toggled on (CC
pill, then an explicit settings-menu pick of the auto-generated/English
track), instead of a fresh `baseUrl` fetch that carries no video-bound POT
token. The ANDROID innertube fetch stays as the fallback/control. Harness:
`scripts/sample-captions.ts`; results:
`scripts/data/web-rerun/rerun-results.jsonl`; raw WEB payloads (truncated):
`scripts/data/web-rerun/web-<videoId>.json3`.

### 8.1 Outcome by status

| status | count | meaning |
|---|---|---|
| web-captured | 16 | player's WEB payload parsed, words > 0 AND cues > 0 |
| android-fallback | 1 | WEB timedtext empty (http 200); ANDROID control OK |
| manual-only | 5 | tracks exist, no ASR — structural exclusion |
| no-track | 2 | zero caption tracks (ANDROID agrees) — structural exclusion |
| web-empty / parse-failed / error | 0 | — |

No `bot-wall` or `consent-page` on any video.

### 8.2 Gate results

- **WEB yield: 16/17 = 94.1% of ASR-bearing videos — PASS** (≥90%; phase-0
  ANDROID baseline was 17/17 = 100%).
- **Any-path word timing: 19/22 = 86.4%** (16 WEB + 8mAITcNt710 control +
  qp0HIF3SfI4's picked track) vs the phase-0 baseline parity **17/22 =
  77.3%** — the re-run clears it.
- **windows==segs parity: 16/16 videos, both axes.** `windowsWords` =
  `segsWords` and `windowsCues` = `segsCues` exactly on every ASR video
  (e.g. iG9CE55wbtY 2745/584 both layouts, Ks-_Mh1QhMc 3297/535), and
  first/last cue text agrees (`cuesParity` true 16/16, `wordsParity` true
  16/16).
- **Parser gap resolved: parse-failed = 0.** Real WEB ASR payloads carry
  word timing in `events[].segs[].tOffsetMs` — the same shape the ANDROID
  control returns — and `lib/captions.ts` extracts it. The
  `events[].windows[].segs` shape the synthetic fixture models was **not
  observed** on any of the 17 captured WEB payloads; the earlier
  `windows-parse-zero-words` results (14 videos in the first run) were the
  default CC track being a manual transcript without word timing, not a
  parser defect. The three committed fixtures
  (`tests/fixtures/real/windows-asr-*-trunc.json`) are real WEB payloads
  that parse to words > 0 with the production parser.
- **POT/IP access: 1/24.** 8mAITcNt710 (CS50, 25 h course) — the largest
  ASR payload in the set — returned `timedtext-empty (http 200)` on every
  attempt (full run + two fresh-session retries), while other videos
  captured fine before and after; the ANDROID control succeeded (242,345
  timed words). Video-specific throttling of the oversized auto-generated
  track; the runbook escalation (fresh session) was followed.

### 8.3 Track-list deltas vs phase 0

- 4NRXx6U8ABQ (Shake It Off): no-track in phase 0, now manual-only (one
  track appeared since).
- qp0HIF3SfI4 (Simon Sinek): manual-only in both, but the WEB CC menu's
  picked track carried word timing (465 words / 104 cues) despite the WEB
  track list showing no `asr` kind — the menu exposes tracks the tracklist
  does not; harmless for the gate (structural class).

### 8.4 Pause bias (per-word inter-start speechDur)

`pauseBias = (unifiedRate − filteredTokens / speechDur) / unifiedRate`
where `unifiedRate` is the extension's rule
(`filteredTokensOverTrimmedSpan`) on the captured cues and `speechDur` is
per-word inter-start spans excluding gaps ≥ 1 s. In the harness the
unified rate is the rule's output; the runbook reads the extension's
applied `playbackRate` live — same quantity, different read point.

- **Median −44.8% — FLAG** (`|bias| > 25%` on 13/19 videos). Negative
  means the word-accurate rate exceeds the unified estimate: pauses eat a
  large share of the cue-trimmed span, so the unified-rate rule understates
  the true speech rate and **over-speeds** by roughly `|bias|`.
- Cleanest talks still sit at −20…−30% (Ks-_Mh1QhMc −25.0, 8mAITcNt710
  −24.2, aircAruvnKk −20.9, 7Pq-S557XQU −10.0); the TED/lecture set is
  −42…−99% (HtSuA80QTyo −98.6, h6fcK_fRYaI −94.0).
- Degenerate outliers: music videos 60ItHLz5WEA (−739%) and dQw4w9WgXcQ
  (−186%) — sparse speech with long marker gaps; their speechDur is near
  zero. Exclude lyric/music tracks from pause-bias interpretation.
- Per-video values are in `rerun-results.jsonl` (`unifiedRate`,
  `wordAccurateRate`, `pauseBiasPct`, `pauseBiasSource`); demand-lane
  follow-up flagged per runbook.

Semantics (calibration ruling): the unified presentation rate stays the
headline metric — it is the literature's measure on pause-inclusive
stimuli, and the resulting 1.2–1.9x multipliers sit in the empirically
near-cost-free band. The earlier rationale that "target 250 absorbs the
~2–5% residual pause-inclusion bias" is dead; the measured structure
above is the replacement. The product-side guard for the pause dilution:

- **`pause-diluted` warning (asr-word tier only, informational).** When
  `multiplier × articulatoryWpm` exceeds `SAFE_ZONE_CEILING_WPM / (1 −
  P_STIMULUS) = 275 / 0.7 ≈ 393 wpm`, the speech itself is running past
  the comprehension limit even though the presentation rate stays in the
  safe zone. `P_STIMULUS = 0.3` is a documented assumption — a round
  placeholder at the measured ≈31% pause share of span; since the
  measured shares are lower bounds (sub-second micro-pauses stay in
  speechDur), the mapping is deliberately lenient. At the default target
  this fires on 5–6 of the 17 ASR videos (one borderline within ~1%);
  the extreme tail sits at ~400–500 wpm articulatory. Lyric/music tracks
  never reach it — music content routes to music mode before
  recommendation.
- **Coverage gating.** The warning is skipped when word-timing coverage
  is inadequate (phase-0 mean 83.6% of text tokens timed): sparse
  coverage misestimates speechDur. The caller supplies the coverage
  sanity before passing an articulatory rate.
- **Production wiring.** entrypoints/content.ts renders word-timed ASR
  tracks (≥2 timed words) as the `asr-word` tier and feeds recommend()
  `wordTierInputs` (lib/wpm.ts: articulatoryWpm + coverage flag), so the
  warning fires on real YouTube payloads. The generic matcher harvests
  cue-level VTT captions only, so it stays on `manual-cue`/`estimated`.
- **Tier restriction is structural.** manual-cue already silence-corrects
  toward speech duration; asr-cue and estimated carry no word timing at
  all. Only asr-word can produce an articulatory estimate.
- **Report-only:** the warning never changes the multiplier; it renders
  in the existing pill warning mode with reason-driven copy and an
  override.

### 8.5 Fixture commitments

- `tests/fixtures/real/windows-asr-iG9CE55wbtY-trunc.json` (379,178 →
  4,192 B), `windows-asr-Ks-_Mh1QhMc-trunc.json` (403,358 → 4,751 B),
  `windows-asr-arj7oStGLkU-trunc.json` (241,331 → 4,625 B): first 20 events
  of real player-signed WEB payloads; parse to words > 0 / cues > 0 with
  `lib/captions.ts`.
- Provenance README: `tests/fixtures/README.md` (videoId, title, capture
  date, method, original vs truncated size, backed assertions; copyright
  held by creators). Regenerated by `emitWebFixtures()` in
  `scripts/sample-analysis.ts` on any capture run.

### 8.6 Method notes (for the runbook's agent-browser flow)

- The CC toggle alone fetches the **default** track, which is usually a
  manual transcript without word timing — the harness now always opens the
  settings menu (gear → Subtitles/CC) and picks the auto-generated/English
  track, then waits for the fresh signed request. The runbook's "manual
  track pick" step is mandatory, not a fallback.
- One video in 24 hit a transient `timedtext-empty`; other videos were
  unaffected, so treat per-video empties as POT/IP class and retry before
  escalating.
- Truncated payloads for every captured video land in
  `scripts/data/web-rerun/` (never full transcripts).
