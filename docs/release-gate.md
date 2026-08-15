# Release gate (box-gated checklist)

The release gate is a box-run procedure, not a CI flag: it needs a
residential machine and real youtube.com sessions. Work through the checklist
in order; a failure at any step stops the release.

## 1. Fresh build

```sh
bun run build
```

The release runs against the build produced from the release commit. A
stale `.output` from a previous checkout does not count — delete
`.output/` before building if there is any doubt.

## 2. Real-site run on the fresh build

```sh
bun run scripts/realsite-runner.ts --headless
```

- Pass ratio must be **≥80%** on this run. Below the bar does not ship.
- The run appends to `scripts/data/realsite-run/results.jsonl`. That file is
  the oracle — the only non-LLM artifact. Entries are **never edited or
  deleted** to make the ratio pass; a failed entry stays failed and is the
  regression tracker for the next wave.
- Commit the new `results.jsonl` with the release. The diff against the
  previous release's file is the regression linkage: same corpus, same
  thresholds, pass ratio compared line by line. A ratio that dropped needs a
  wave commit that fixes it before the release proceeds.

## 3. Golden-master human checkpoint

The recorded baseline changed (or held) in step 2. One pair of eyes reviews
the golden-master diff — this is the only gate that cannot mirror. Sign the
checkpoint in the release PR:

```
Golden-master diff reviewed: <date> — <reviewer>
```

No script replaces this line. Without it the release does not ship.

## 4. Stryker tripwire

The nightly mutation run must not exceed **65 survivors** on the release
commit. On breach, fix the surviving mutants — never add tests that paper
over them. The tripwire is checked against the same commit that ships.

## Ship

All four steps green, the sign-off line present, the `results.jsonl` diff
committed: the release proceeds to the normal PR and CI path.
