# Real caption fixtures — provenance

Captured 2026-08-12 from a residential IP via the POT-aware harness (scripts/sample-captions.ts, scripts/measure-corpus.ts): the player's own signed /api/timedtext response, intercepted while captions were toggled on — no fresh baseUrl fetches, so the POT token and signature are the ones the player used.

Full transcripts are not committed: every fixture is truncated to the first 20 events (and first 12 top-level windows) of the payload. The captions are the work of their creators; copyright remains with them.

| fixture | videoId | title | capture date | capture method | original bytes | truncated bytes | backs |
|---|---|---|---|---|---|---|---|
| windows-asr-iG9CE55wbtY-trunc.json | iG9CE55wbtY | Do schools kill creativity? / Sir Ken Robinson / TED | 2026-08-12 | player-signed intercept (page.on('response'), CC toggled on) | 379178 | 4192 | word timing parsing (words > 0 on a real WEB payload); windows==segs cue parity |
| windows-asr-Ks-_Mh1QhMc-trunc.json | Ks-_Mh1QhMc | Your Body Language May Shape Who You Are / Amy Cuddy / TED | 2026-08-12 | player-signed intercept (page.on('response'), CC toggled on) | 403358 | 4751 | word timing parsing (words > 0 on a real WEB payload); windows==segs cue parity |
| windows-asr-arj7oStGLkU-trunc.json | arj7oStGLkU | Inside the Mind of a Master Procrastinator / Tim Urban / TED | 2026-08-12 | player-signed intercept (page.on('response'), CC toggled on) | 241331 | 4625 | word timing parsing (words > 0 on a real WEB payload); windows==segs cue parity |
| windows-asr--rg9mV6DBl4-trunc.json | -rg9mV6DBl4 | Физика элементарных частиц – курс Дмитрия Казакова / ПостНаука | 2026-08-14 | player-signed intercept (page.on('response'), CC toggled on) | 2023524 | 3726 | ru word timing parsing (words > 0 on a real ru WEB payload); windows==segs cue parity (ru-corpus G4 anchor) |

## Synthetic fixtures — provenance gate

Every fixture data file under `tests/fixtures/synthetic/` (*.json/*.vtt/*.srt) must be named in the table below with its derivation lineage AND an `evidence` citation the gate verifies exists: a golden-master registry fixture (`real/<name>`), a committed file path (`BUG_ZOO.md`, an e2e spec), a `scripts/data/*.jsonl` record (`scripts/data/<file>.jsonl#<videoId>`), or a commit hash. `scripts/audit-lanes.ts` fails on any synthetic fixture this table does not name, on a lineage row whose evidence does not exist, and on a row with no citable evidence. Name-matching reads only the table rows — a fixture mentioned in prose or a comment buys no exemption. Non-data assets (`hls/*.m3u8`, `media/silence.webm`) are outside the gate.

| fixture | lineage | evidence |
|---|---|---|
| synthetic/chaptered.json | authored for the chaptered e2e lane (73862eb): three 30 s spans (fast speech / lyrics / slow speech) in the word-timed json3 shape, with the chapter markersMap injected by the fixture server (e2e/shared/fixtures.ts CHAPTERED_FIXTURES) | 73862eb; e2e/shared/fixtures.ts |
| synthetic/cooldown-expired.json | bug-zoo lane (673e0a9): word-timed json3 in the pot-gated shape, served on the signed-fetch page; pins the second drive re-picking once the 30 s cooldown has passed | 673e0a9; BUG_ZOO.md |
| synthetic/cue-level-only.json | manual-track shape of the captured real/manual-cue.json (qp0HIF3SfI4): segs without word timing, no windows | real/manual-cue.json; scripts/data/sample-results.jsonl#qp0HIF3SfI4 |
| synthetic/dzen-word.vtt | Dzen player's word-timed VTT shape (ru), authored for the track-src harvest probe (b5bcf26) | b5bcf26 |
| synthetic/edx-transcript.json | edX transcript shape ({start, text} arrays), authored for the network-layer harvest parser (37a246d) | 37a246d |
| synthetic/empty.json | empty-payload case for the wpm pipeline (3c99d7d) | 3c99d7d |
| synthetic/gapped.json | authored for the skip-silence gap lane (c8ad7ca): a recommend-mode 1.4x cue timeline with one exactly-1.5s inter-cue gap (e2e/shared/specs.ts runSkipSpecs) | c8ad7ca; e2e/shared/specs.ts |
| synthetic/hls/talk/talk.vtt | VTT segment referenced by the generic-matcher HLS playlist (d4239ad), served to e2e/generic.html | d4239ad; e2e/generic.html |
| synthetic/ja-captions.json | word-timed json3 in the captured WEB ASR shape with ja segs, authored for the language-unit chain e2e (b31d3c1) | b31d3c1 |
| synthetic/late-controls.json | bug-zoo lane (673e0a9): word-timed json3 in the pot-gated shape; controls mount 4 s past the drive's 3 s visibility wait (LATE_CONTROLS_FIXTURES) | 673e0a9; BUG_ZOO.md |
| synthetic/music-lyrics.json | music-track word-timed shape for the pill recommendation lane (353538a) | 353538a |
| synthetic/music-segments.json | music-video events + windows shape for the wpm pipeline (3c99d7d) | 3c99d7d |
| synthetic/no-controls.json | bug-zoo lane (673e0a9): word-timed json3 served on the plain watch page with no control stub (NO_CONTROLS_FIXTURES) | 673e0a9; BUG_ZOO.md |
| synthetic/out-of-order.json | out-of-order event/window timeline edge for the wpm pipeline (3c99d7d) | 3c99d7d |
| synthetic/pot-gated.json | base word-timed json3 for the POT-gated signed-fetch lane (a3280a6): the stub player pays the payload only to signed /api/timedtext fetches (POT_GATED_FIXTURES); shape ancestor of the bug-zoo fixtures | a3280a6; BUG_ZOO.md |
| synthetic/rutube.srt | rutube SRT shape (ru), authored for the track-src harvest probe (b5bcf26) | b5bcf26 |
| synthetic/sample.vtt | VTT shape with markup, authored for the network-layer harvest parser (37a246d); referenced by synthetic/hls/master.m3u8 | 37a246d; tests/captions-harvest.test.ts |
| synthetic/single-word.json | single-event minimal case for the wpm pipeline (3c99d7d) | 3c99d7d |
| synthetic/transcript-gated.json | authored for the get_transcript fallback lane (d6762be): ANDROID player response whose transcript-panel params back the POST; parses to no captions (TRANSCRIPT_GATED_FIXTURES) | d6762be |
| synthetic/windows-format.json | format-drift sentinel (7b3a0cf): the events[].windows[].segs shape no recorded WEB payload has used since the residential re-run — the shape the recorded windows-asr-* payloads are NOT; the parser must keep handling it | 7b3a0cf |
| synthetic/word-level.json | word-timed json3 in the captured real/asr-word.json event/seg shape (ANDROID iG9CE55wbtY), truncated to 3 events | real/asr-word.json; scripts/data/sample-results.jsonl#iG9CE55wbtY |
