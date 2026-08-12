# Real caption fixtures — provenance

Captured 2026-08-12 from a residential IP via the POT-aware harness (scripts/sample-captions.ts): the player's own signed /api/timedtext response, intercepted while captions were toggled on — no fresh baseUrl fetches, so the POT token and signature are the ones the player used.

Full transcripts are not committed: every fixture is truncated to the first 20 events (and first 12 top-level windows) of the payload. The captions are the work of their creators; copyright remains with them.

| fixture | videoId | title | capture date | capture method | original bytes | truncated bytes | backs |
|---|---|---|---|---|---|---|---|
| windows-asr-iG9CE55wbtY-trunc.json | iG9CE55wbtY | Do schools kill creativity? / Sir Ken Robinson / TED | 2026-08-12 | player-signed intercept (page.on('response'), CC toggled on) | 379178 | 4192 | word timing parsing (words > 0 on a real WEB payload); windows==segs cue parity |
| windows-asr-Ks-_Mh1QhMc-trunc.json | Ks-_Mh1QhMc | Your Body Language May Shape Who You Are / Amy Cuddy / TED | 2026-08-12 | player-signed intercept (page.on('response'), CC toggled on) | 403358 | 4751 | word timing parsing (words > 0 on a real WEB payload); windows==segs cue parity |
| windows-asr-arj7oStGLkU-trunc.json | arj7oStGLkU | Inside the Mind of a Master Procrastinator / Tim Urban / TED | 2026-08-12 | player-signed intercept (page.on('response'), CC toggled on) | 241331 | 4625 | word timing parsing (words > 0 on a real WEB payload); windows==segs cue parity |
