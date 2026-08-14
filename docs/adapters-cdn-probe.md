# CDN fetch probe — Dzen/Rutube caption carriers, measured

Measured 2026-08-14 on the dev box (WSL2 over a residential Windows 11
line — same framing as `docs/vk-probe.md`). Data:
`scripts/data/adapters-cdn-probe/results.jsonl` (6 records). Probe:
`scripts/adapters-cdn-probe.ts` (+ `scripts/adapters-cdn-probe-lib.ts`),
Playwright CfT chromium, ru-RU locale, headed, no login, no bypass.

The gap this closes: `docs/adapters.md` documented the adapters' page-context
cors-mode `fetch` of `video > track[src]` carriers as an inference — the
vk-probe only ever saw the players' own NO-CORS element loads, which prove
nothing about `fetch()` (an opaque media load needs no
`Access-Control-Allow-Origin`; a cors-mode fetch rejects without it). This
probe issues the exact production fetch against real carriers and records the
outcome.

## Method

Per video: goto → wall check → wait for the player → play + CC toggle →
10 s capture window → read `track[src]` exactly as production
(`entrypoints/generic.content.ts`), then per src a page-context cors-mode
`fetch` (the exact production call) in the frame that exposed the track.
Outcomes are classified by the unit-tested `classifyCarrier`: rejected fetch
→ `cors-blocked`; `status 403` → `signed-expiry`; other ≥400 → `http-error`;
ok with an empty parse → `parse-fail`; else `fetch-ok`. Fetch-ok bytes are
parsed in Node by the production parsers (`parseVttWords`, then `parseVtt`
with the `parseSrt` fallback) — CORS is a fetch-time property, parsing is
deterministic given bytes. No-cors element loads are never counted; only the
explicit fetch outcome.

Sample: manifest seeds from probe-verified caption-bearing vk-probe records
(3 Dzen word-timed, 2 Rutube cue-timed) with trending top-up to ~6 per
platform. Every URL is re-verified at runtime; walls and dead mounts are
recorded honestly.

## Results

| platform | status | carriers | evidence |
|---|---|---|---|
| Dzen | `word-ok` ×3 | 1/1, 1/1, 1/1 | cors-mode fetch resolved `200` with real VTT bytes on all three (`vd672/vd464/vd744.okcdn.ru`), parsed 863 / 1681 / 518 words (368 / 710 / 182 cues) |
| Dzen | `no-video` ×1 | 0/0 | no video element mounted (30 s) |
| Rutube | `no-video` ×2 | 0/0 | no video element mounted on either verified seed (27–29 s) |

Carrier outcomes over the reachable sample: reachable = 3, fetch-ok = 3
(100%), cors-blocked = 0, signed-expiry = 0, http-error = 0, parse-fail = 0.
All three ok responses recorded `acao: null` — the page observed no ACAO
header, yet the cors-mode fetch resolved with status 200 and real bytes. A
cors-mode fetch that fails the browser's CORS gate rejects; an `ok:true`
fetch has passed it. The acao value is recorded as observed, not assumed.

## Verdict: PASS

Per the spec's criteria, on the reachable sample:

1. **Zero cors-blocked** — 0/3 carrier outcomes. The exact assumption holds:
   Dzen's `vd*.okcdn.ru` carriers answer the production cors-mode fetch from
   the dzen.ru page context.
2. **≥80% reachable carriers fetch-ok** — 3/3 = 100% (denominator excludes
   the three no-video records structurally; they produce no carrier outcome).
3. **Zero parse-fail** — all three fetch-ok bodies parsed with word counts
   far above the ≥2 gate.

`docs/adapters.md` now documents the path as measured (see the CORS bullet).

## Honest limits

- **Rutube unmeasured at fetch level.** Both verified Rutube seeds mounted
  no video element and the trending top-up never ran (the run was terminated
  after the seeds). The fetch-level claim here is Dzen-only: 3 carriers
  across 3 track-bearing videos. Rutube's `pic.rtbcdn.ru` SRT carriers were
  seen by the vk-probe at the network layer, but their cors-mode fetch
  behavior remains unmeasured.
- **`acao: null` on every ok response.** The page saw no
  `Access-Control-Allow-Origin` header on any of the three resolving fetches.
  The classification rule treats an `ok:true` cors-mode fetch as having
  passed CORS (it resolves only if the response passes the browser's CORS
  check), and the spec anticipated ACAO-absent ok fetches; the header
  arrangement itself is opaque to the page and is recorded as-is.
- **Signed-URL expiry skews the denominator.** Dzen track URLs carry
  `expires=…`; a lapsed URL fetches 403 and is classified `signed-expiry` —
  a delivery limit, not a CORS finding. None occurred this run; the class
  stays binding in production (no refresh attempt).
- **Curated sample, not trending-random.** The manifest seeds are
  probe-verified caption-bearing videos; top-up is trending but never ran.
  This measures CORS on known-good content, not caption coverage — that was
  the vk-probe's job.
- **No-cors loads prove nothing.** Only the explicit cors-mode fetch counts;
  the players' opaque element loads were never consulted.
- **Headed default.** CORS behavior is identical headless; headed matches
  production session reality.
- **Rutube author gate (~50%).** No-track stays expected on author-gated
  videos; this run saw no-track zero times and no-video three times instead.
- **Not a parser re-validation.** parse-fail is recorded, but the PASS/FAIL
  verdict turns on the fetch.
