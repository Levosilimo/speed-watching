# Launch Notes — Speed Watcher v0.0.2

Pre-launch assets and day-of checklist for the Show HN post, the first
comment, and the Reddit engagement. Grounded in the research playbook
(`lib-31`, `lib-32`), the listing copy (`docs/store-listing.md`), the
language model (`docs/languages.md`), and the privacy posture
(`docs/privacy-policy.md`).

Every claim below matches the repo docs. The science is hedged, the playbook
rules are respected, and nothing here names a competitor.

---

## 1. Show HN post

### Title (≤80 chars)

> Show HN: Speed Watcher – recommends playback speed from caption speech rate

75 chars. The hook is the mechanism, not a superlative: caption speech rate
tells you it's WPM-based, not fixed multipliers.

### Body (~150–250 words)

Playback speed in most video players is a fixed multiplier: you guess 1.5×,
hope it's not too fast, and re-adjust. Speed Watcher removes the guessing.

It reads the word-timed caption data a video already carries, computes the
video's natural speech rate, and recommends the playback multiplier that
lands your effective listening speed in the 250–275 words-per-minute range — a
commonly cited comfortable range for speech. Default target is 250 wpm;
you can set anything from 100 to 400. Why 250? It's the reading-parity
anchor: silent reading runs 240–260 wpm (Kuperman et al.), and listening
comprehension stays high to ~275 — 250 is roughly the speed you'd read
this at.

What it does differently:

- **Suggests, never forces.** A pill on the video shows the recommendation;
  one click applies it, or dismiss it. Your manual speed is always respected.
- **Slows down fast talkers.** Fast speakers land above the range, and it
  recommends slowing the video rather than always pushing faster.
- **Keyboard shortcuts.** Alt+Shift+S applies the recommendation,
  Alt+Shift+D dismisses it.
- **Live rate line.** After you apply, the pill shows your actual rate in
  real time — "now ≈ 248 wpm at 1.55x" — so you see where you land, not
  just the multiplier.
- **Notices music.** Music tracks get the recommendation skipped, not
  miscounted as speech.
- **Privacy is local-only.** Nothing is transmitted. The extension reads
  caption data from the page's own context and makes no outbound requests.

The 250–275 wpm range is a commonly cited target for comfortable listening;
research on comprehension at higher rates is mixed. It's a recommendation
from your video's own speech rate, not a claim that faster is always better.

---

## 2. First comment (honest-science anchor, ~200 words)

> The short version of the science: 250–275 wpm is the effective-rate frame,
> and it reconciles the two studies that look like they contradict each
> other. A 2025 meta-analysis found comprehension starts falling off once you
> get to 2× and beyond — the "safe zone then cliff". A 2026 study found 1.5×
> and 2× had no significant effect on objective comprehension. Both are
> right, because the binding constraint is the *rate*, not the multiplier.
> The meta-analysis tested content whose effective rate pushed past the
> ceiling; the 2026 study tested those multipliers on slower content that
> stayed under it. Target the rate, and the multiplier question mostly
> answers itself.
>
> Honest caveats: measured wpm over a whole track gets diluted by pauses, so
> a lecture with long silences shows a lower rate than the talking parts
> actually run — the pill carries a warning in that case. Non-English targets
> are labeled derived estimates, not measurements; only the Chinese ceiling
> and the English rate are comprehension-measured. DRM-protected video can't
> be read from captions the same way, so it falls back to an estimate.
>
> What it does *not* solve: genuinely comprehension-heavy material at the
> top of the range, DRM-locked pages, and caption-less videos.
>
> What I'd love: feedback on the edge cases — multi-speaker talks, lectures
> with heavy pause structure, and any language where the derived target feels
> wrong. That's where the next iteration lives.

---

## 3. Reddit comment angles

### r/GetStudying / r/GetDisciplined (comment game — no launch posts)

These two subreddits ban launch posts. Engage in the existing
"distracted while watching lectures" and "is 2× bad" threads as a
problem-solver. First-person, specific, no link in the first sentence; link
only if asked. Each is ready to drop into a relevant thread.

**1. The lecture-pause angle (for "I can't focus through lectures" threads)**

I stopped treating playback speed as a guess. The trick that worked for me
was paying attention to the *talk rate*, not the multiplier — a slow,
pausing lecturer at 2× is a completely different experience from a fast
talker at 2×. I started watching what the actual words-per-minute was and
setting speed to land around 250 wpm. Lectures with a lot of silence turn
out to need less boosting than I assumed, because the pauses were doing
half the "slow" work.

**2. The fast-talker angle (for "the professor talks too fast" threads)**

Most speed tools only go up, but some professors genuinely need *slowing
down*. What finally worked for me was a setup that could go either direction
— it measures the speaker's rate and recommends a multiplier to hit a
comfortable listening speed. For the fast-talking prof, that meant playing
at 0.85× and actually following the material for once instead of pausing
every thirty seconds.

**3. The "is 2× bad" angle (for the 2× comprehension threads)**

The research on 2× is genuinely mixed, and the honest reading is that the
*rate* matters more than the multiplier. A 2025 meta-analysis showed
comprehension starting to fall off past 2×; a 2026 study found 2× was fine.
The reconciliation is that it depends on how fast the source content
already is. If the video is already near conversational speed, 2× pushes
you past the comfortable range; if it's a slow lecture, 2× is fine. Rate,
not the number.

**4. The distraction angle (for "I rewind constantly" threads)**

I found a chunk of my "I can't focus" was actually "I've re-watched the same
sentence three times because I set the speed wrong." Watching at a speed
matched to the actual speech rate cut the rewinding down a lot, because I
wasn't straddling the line between "too slow to hold attention" and "too
fast to catch." Finding the speed that sits in the middle changed the
session more than any focus technique did.

**5. The gentle-recommendation angle (for "how do I speed up without losing it")**

The setup I landed on doesn't force anything — it shows a suggestion and I
decide. That turned out to matter more than I expected. Knowing the *why*
(here's the speech rate, here's the suggested multiplier to hit a comfortable
range) made me trust the speed I picked instead of second-guessing it every
five minutes. Applied when I agreed, dismissed when I didn't.

**6. The non-English angle (for study threads with international lectures)**

One thing most speed tools miss: "words per minute" only means something
for English. If you're watching lectures in Japanese or Spanish or German,
the target rate is different — syllables and morae aren't the same as words.
I found a tool that handles that and labels the per-language targets as
derived estimates rather than pretending they're measured. If you watch a
lot of non-English material, that distinction matters.

**7. The music-detection angle (for "it counts music as talking" threads)**

The annoying thing about speech-rate tools on lecture playlists was when a
video had a music intro and the tool treated it as fast talking and
recommended slowing it down. The one I use skips music tracks so the
recommendation is actually about the speech. Small thing, but it stops a
whole class of wrong suggestions.

### r/chrome_extensions launch post body

The one on-topic venue for a launch post. Adapted from the Show HN body,
more utility-focused. Never cross-post the Show HN text verbatim.

**Title:** Speed Watcher – recommends playback speed from the video's own
caption speech rate

**Body:**

Playback speed in most players is a fixed multiplier, so you guess 1.5× and
re-adjust. Speed Watcher reads the word-timed caption data a video already
carries, computes its natural speech rate, and recommends the multiplier
that lands your effective listening speed in the 250–275 wpm range (default
target 250, adjustable 100–400).

The useful differences: it **suggests, never forces** — a pill shows the
recommendation, you apply or dismiss, and your manual speed is always
respected; it **slows down fast talkers** instead of only ever going faster;
it **skips music** so it's not miscounted as speech; and it's **local-only** —
no data leaves the browser, no network requests from the extension. Keyboard
shortcuts (Alt+Shift+S apply, Alt+Shift+D dismiss) and a live rate line show
where you actually land after applying.

The 250–275 wpm range is a commonly cited comfortable listening range;
comprehension research above it is mixed, so this is a recommendation from
the video's own speech rate, not a claim that faster is better. English is
measured; non-English targets are labeled derived estimates. DRM-protected
pages fall back to an estimate.

Firefox and Chrome builds are both shipping. Feedback on edge cases —
multi-speaker talks, pause-heavy lectures, non-English rates — is what I'm
after.

---

## 4. Launch-day checklist

Run in order. The store links must resolve before any traffic points at
them.

### Pre-traffic (days before)

- [ ] CWS submitted first (manual review track 1–3 wk: `<all_urls>` +
      `tabCapture`/`offscreen`). AMO submitted same day (instant auto-review,
      free second storefront).
- [ ] **Store links live before traffic.** Homepage and privacy policy hosted
      and returning 200 (GitHub Pages); replace the placeholder URLs in the
      CWS listing and AMO metadata before submit. Confirm both store pages
      resolve when logged out.
- [ ] Privacy policy URL pasted into the CWS Privacy tab (mandatory field).
- [ ] Version `0.0.2` zip uploaded; `bun run check:cws` exits 0.
- [ ] Screenshot regenerated for the current options UI; real icons verified.

### Show HN day

- [ ] Post **Tue–Thu, 8–11 am ET** (US East morning = peak HN).
- [ ] Title ≤80 chars: "Show HN: Speed Watcher – recommends playback speed
      from caption speech rate".
- [ ] First comment is the honest-science anchor (Section 2) — posted
      immediately after the post, not hours later.
- [ ] **Respond to every comment for the first 2+ hours.** Answer the
      science questions with the effective-rate frame; don't dodge the
      mixed-research honesty.
- [ ] Pre-empt YouTube's native Auto Speed (Premium, ~June 2026): it sets a
      rate without showing you the speech rate. Speed Watcher's pitch is the
      information gap — the measured rate and where your effective rate
      lands. Also free, desktop, works without Premium, and slows down fast
      talkers. Do not dismiss it.

### Reddit

- [ ] r/GetStudying and r/GetDisciplined: comment-only. No launch posts —
      they're banned. Use the thread-matched comments in Section 3; link
      only if asked.
- [ ] r/chrome_extensions: the single on-topic launch post. Post the
      Section-3 body, no cross-post of the Show HN text.
- [ ] Never cross-post between subreddits or HN.

### Copy rules (every venue)

- [ ] No superlatives, no keyword stuffing, no competitor names.
- [ ] Science hedged: "commonly cited range", "research on comprehension at
      higher rates is mixed" — not a claim of proof.
- [ ] Honest scope: DRM fallback, derived-estimate labels, pause dilution.
- [ ] No AI-slop: no throat-clearing openers, no importance puffery, no
      banned words (delve, leverage, seamless, robust, comprehensive, dive
      into, streamline, elevate, unlock, effortless, landscape).

### After day one

- [ ] 100 installs + 3+ reviews flips CWS organic discovery — the follow-up
      comments are the lever (~80% of the first 100 installs come from
      comment replies), so keep replying through day one.
- [ ] ~50% week-1 churn is normal; don't read a quiet week as failure.
