# Measured-Rate Provider

The measured-rate provider (`wpm:get`) lets a partner extension ask Speed
Watcher for the measured speech rate of the video in the active tab — the
same number the pill's recommendation is built from. The partner uses it to
synchronize its own playback speed with Speed Watcher's measurement
(speech-rate daisy-chain).

The feature is opt-in at three layers; all three must be in place before a
single request is served:

1. The user enables **Integration → Allow measurement requests** in the
   options page (`externalApiEnabled` setting, default off).
2. The partner's extension ID is added to `ALLOWED_PROVIDER_IDS`
   (`entrypoints/background.ts`).
3. The same ID is added to `externally_connectable.ids` (`wxt.config.ts`).

Layers 2 and 3 mirror each other; a partner is only fully onboarded when
both list the ID. The manifest layer is the enforcement point (an empty
`ids` array makes the API unreachable at the runtime layer), the code
allowlist is defense-in-depth against drift.

## Request

The partner sends a `runtime.sendMessage` to Speed Watcher's extension ID:

```json
{ "type": "wpm:get", "version": 1 }
```

External messaging needs no `externally_connectable` to reach an extension;
the manifest key exists to *restrict* who can connect.

## Response

```json
{
  "ok": true,
  "version": 1,
  "ts": 1720000000000,
  "site": "youtube.com",
  "naturalRate": 160.25,
  "unit": "wpm",
  "language": "en",
  "tier": "asr-word",
  "contentType": "lecture",
  "platformMax": 2,
  "recommendation": {
    "target": 250,
    "recommendedMultiplier": 1.55,
    "mode": "recommend"
  }
}
```

| Field | Meaning |
|---|---|
| `ts` | Measurement timestamp, epoch ms |
| `site` | Bare hostname of the measured page |
| `naturalRate` | Measured speech rate in `unit`; null-ish values are never sent (a failed measurement answers `ok: false`) |
| `unit` | Rate-unit display label: `wpm`, `cpm`, `syl/min`, or `morae/min` |
| `language` | Resolved language-model code (`lib/languages.ts`); `null` when no model maps, in which case English defaults apply |
| `tier` | Measurement confidence: `asr-word`, `asr-cue`, `manual-cue`, or `estimated` |
| `contentType` | `lecture`, `talk`, `podcast`, `music`, `explainer`, `news`, or `generic` |
| `platformMax` | The site's playback-speed cap |
| `recommendation.target` | The safe-zone target the recommendation steers toward, in `unit` |
| `recommendedMultiplier` | `target / naturalRate`, rounded to 0.05 and clamped to `[0.5, platformMax]` |
| `recommendation.mode` | `recommend`, `warning`, `unreachable`, or `music` |

Errors are `{ "ok": false, "error": "<code>" }`:

| Code | Meaning |
|---|---|
| `disabled` | The options toggle is off |
| `forbidden` | Sender ID not in `ALLOWED_PROVIDER_IDS` |
| `rate_limited` | More than 10 requests per 10 s from this sender |
| `no-active-video` | No active tab, no content script, or no measurement yet |
| `internal` | Any unexpected failure (the listener never throws) |

Data minimization: the response carries no `videoId` and no URL.

## Serving path

```
partner extension ──sendMessage──▶ background (onMessageExternal)
   ──tabs.sendMessage──▶ ISOLATED bridge ──window envelope──▶ MAIN-world
   content script (answers from its measurement context)
   ◀── window envelope ──────────────────────────────────────┘
   ◀──sendResponse── background clamps numeric fields ──▶ partner
```

The background's guards run in order, cheapest first, so a disabled or
unknown sender never reaches the tab round trip (service-worker wake
abuse protection):

1. shape: `type === 'wpm:get'` and `version === 1`, else no response
2. `settings.externalApiEnabled`, else `disabled`
3. `sender.id` in the allowlist, else `forbidden`
4. per-sender sliding window (10 requests / 10 s), else `rate_limited`
5. `tabs.query({ active: true, currentWindow: true })`; no tab → `no-active-video`
6. `tabs.sendMessage` with the request; the bridge relays it to the window
   channel and forwards the validated answer back; the background clamps
   every numeric field (`naturalRate` to `[1, 1000]`, `recommendedMultiplier`
   to `[0.5, platformMax]`, `ts` to `[0, now]`) before `sendResponse`

Every cross-boundary payload is shape-validated (SEC pattern, same as the
bridge envelopes in `lib/messaging.ts`): the bridge validates the window
answer before forwarding it, and the background re-validates the response
that crosses back from the tab world. The whole listener is wrapped so an
unexpected failure answers `internal` instead of leaving the partner
hanging.

## Partner opt-in flow

1. The partner implements the listener for Speed Watcher's `wpm:get`
   responses (send the request, read the response — no negotiation).
2. The user enables the options toggle.
3. A release adds the partner's ID to both `ALLOWED_PROVIDER_IDS` and
   `externally_connectable.ids` (two-list mirror).

Until step 3 ships, requests answer `forbidden` (toggle on) or never reach
the extension (manifest empty). A revoked partner is removed from both
lists; the toggle alone does not revoke a shipped partner.

## Context menu

The "Measure this video's rate" item (`entrypoints/background.ts`,
`contexts: ['link']`) opens the link in a tab; the existing measurement
pipeline takes over there — the youtube script measures watch pages, the
generic matcher every other page with a `<video>` — and the pill appears
naturally. The handler has no navigation logic beyond `tabs.create` and
ignores non-http link URLs. The menu persists across service-worker
restarts; a `hasListener` id-guard prevents duplicate registration.

## Core library

The measurement math itself (`lib/wpm.ts`, `lib/tokenizer.ts`,
`lib/captions.ts`, `lib/languages.ts`, `lib/recommend.ts`) is chrome-free
and DOM-free — see `docs/core-library.md` for the export surface and
standalone porting notes (mpv Lua, userscripts).
