# Kickoff: starting a new video in a fresh session

Three ways to start, ordered by how much is reused. Pick one, then hand the
matching prompt to the new session.

| Mode                            | Reuses                                     | Work                        | When                                 |
| ------------------------------- | ------------------------------------------ | --------------------------- | ------------------------------------ |
| **A. Re-record this video**     | everything                                 | recapture + render, ~10 min | app UI moved, same story             |
| **B. New story, same pipeline** | capture/voice/render tooling, demo dataset | half day to two days        | new narrative, new scenes            |
| **C. Separate production**      | tooling only                               | its own branch/worktree     | different product, different dataset |

---

## A. Re-record the existing video

No new session design work needed. Paste this:

```text
Re-record the Volunteer Relay hackathon video in this repo.

1. Read AGENTS.md, video/docs/state.md, video/docs/recording-runbook.md and
   video/docs/decisions.md first.
2. Run `bun run video:doctor`. Report blockers before changing anything.
3. Follow the "Resume in a fresh session" block in video/docs/state.md exactly.
4. Recapture only if generated/capture-manifest.json appCommit differs from HEAD
   and the UI changed; otherwise reuse existing captures and re-render.
5. Finish with `bun run video:validate`, `bun run video:verify` and `bun run verify`.
   Refresh video/review/ and update the two "footage commit" rows
   (video/review/README.md and video/docs/readiness-report.md).
6. Do not touch application code, contracts, migrations or root manifests beyond
   what video/** requires.
```

---

## B. New story on the same pipeline (most common)

### Paste-ready kickoff

```text
Produce a new Volunteer Relay demo video using the existing video/** pipeline.

Read first: AGENTS.md, VIDEO-AGENT-PROMPT.md, video/README.md,
video/docs/state.md, video/docs/decisions.md, video/docs/feature-audit.md,
video/docs/improvement-backlog.md.

Scope you own: video/**, plus the recording-fixture files already in
video/fixtures/. Do NOT change apps/**, packages/**, root manifests, lockfile or
CI. If you need a contract/dependency/seed change, stop and request it.

Deliver:
1. video/scenes.json — typed scene manifest for the new story (8-10 scenes,
   <=180 s total). Product scenes must name a capture plan
   (checkpointId, role, route, readyText) and a matching action in
   video/scripts/lib/actions.ts. Graphic scenes must have capture: null.
2. video/narration/script.md — word-for-word in sync with scenes.json
   (`video:voice -- --dry-run` fails on drift). Target 350-390 words.
3. video/fixtures/expected-results.json — independently authored checkpoint
   totals for every capture action you add. Never copy numbers from app output.
4. Capture actions with real cursor/typing/clicks and checkpoint assertions
   before and after each action; annotate only page-level headings.
5. Real narration (ask before spending money), timeline, proof, final render,
   validation, refreshed video/review/ and updated docs.

Constraints: single capture origin per delivery; no faked application states; no
invented metrics; captions from provider alignment; loudness -16 LUFS / <=-1 dBTP.
Finish with `bun run video:validate` 0 blockers, `video:verify` and `bun run verify`
green, then a small conventional commit.
```

### Phase plan

### Phase 1 — story and manifest (~1 h, no cost)

1. Decide the narrative spine: 1 problem beat, 3–5 product beats, 1 close.
2. Write narration first, then split it across scenes. Keep each product scene's
   narration ≤ ~25 s; the timeline caps scenes at `maxSeconds`.
3. Draft `scenes.json` with `minSeconds` below `narration + 0.6 s` (no dead air) and
   `maxSeconds` ~6 s above the expected narration length.
4. Mirror the text into `narration/script.md`, then validate:
   `bun run video:voice -- --dry-run` (checks sync + character cost).

### Phase 2 — capture actions and oracle (~2–4 h, no cost)

1. For each product scene add an entry in `video/scripts/lib/actions.ts` with
   `startsFrom`, `establishes` and a `run(context)`.
2. Use only the contract helpers: `context.click(locator)`,
   `context.typeInto(locator, text)`, `context.fill(locator, value)`,
   `context.region(label, locator)`, `context.mark(label)`.
3. Assert totals with `assertTotals(context, checkpointId)`; every scene must prove
   its starting checkpoint and, when it mutates state, the resulting one.
4. Author the expected numbers by hand in `fixtures/expected-results.json`
   (derive them from `fixtures/demo/expected-start.json` + the fixture definitions,
   never from a run).
5. Record regions **after** interactions, and only for elements that never scroll
   (page headings). Inner panes scroll independently and boxes drift.

### Phase 3 — capture and iterate (~30 min per pass)

```sh
bun run video:prepare          # local: disposable DB + seed + baseline check
bun run video:auth
bun run video:capture -- --fresh
bun run video:timeline
bun run video:proof            # 18 s excerpt, fast feedback
```

Inspect stills from the proof (`ffmpeg -ss <t> -i video/output/proof.mp4 -frames:v 1`)
before rendering the full programme. Fix alignment/pacing here, not later.

### Phase 4 — voice, final, handoff (~1 h + narration cost)

```sh
bun run video:voice -- --dry-run   # show cache misses and billable characters
bun run video:voice -- --yes       # confirm cost first
bun run video:timeline
bun run video:proof && bun run video:render
bun run video:validate
bun run video:verify && bun run verify
```

Then refresh `video/review/`, update `docs/state.md` (snapshot + footage commit),
`docs/readiness-report.md` (numbers), `review/README.md` (provenance) and commit.

---

## C. Something that diverges a lot

Create `video/productions/<name>/` with its own `scenes.json`, `fixtures/`,
`narration/` and `review/`, and pass the paths through the scripts (they read
`video/scenes.json` today, so this needs a small `--scenes`/`--out-dir` argument —
treat it as a tooling change inside `video/**`, same branch, same gates).

Use this only when the new video shares little with the current story; otherwise
Mode B is cheaper.

---

## Scene schema cheat-sheet

```jsonc
{
  "id": "S03", // /^S\d{2}$/, unique
  "title": "One everyday update",
  "kind": "product", // "product" needs capture, "graphic" must not have one
  "narration": "…", // must match narration/script.md exactly
  "onScreenDisclosure": null, // optional small corner tag
  "capture": {
    "checkpointId": "baseline", // must exist in fixtures/expected-results.json
    "role": "coordinator", // coordinator | volunteer | owner | report-reader
    "route": "/workspace/inbox",
    "readyText": "Awaiting review" // must be visible before recording starts
  },
  "overlays": [{ "text": "…", "atSeconds": 1, "holdSeconds": 5 }],
  "focus": [
    { "x": 0.3, "y": 0.42, "scale": 1.06, "atSeconds": 1, "holdSeconds": 8 }
  ],
  "annotations": [], // only stable regions, e.g. "heading"
  "minSeconds": 18,
  "maxSeconds": 32
}
```

Rules enforced by the tooling: product scenes must have a capture plan and a
registered action; scene ids are unique; minimum durations must fit inside
`maxSeconds` (180 s); narration + 0.6 s tail must fit the scene cap; footage must be
at least as long as its scene; the programme must stay under `maxSeconds`.

## Story guardrails (kept from the brief)

- Real application footage only for product claims; graphics may illustrate but
  never simulate product success.
- No invented numbers: no time savings, accuracy or adoption claims.
- One capture origin per delivery; manifests record the app commit.
- Synthetic demo data only; never real people, messages or beneficiaries.
- Captions derive from provider alignment; loudness −16 LUFS, peak ≤ −1 dBTP.
- Ask before any paid generation; cache misses only.

## Definition of done

```sh
bun run video:doctor      # no blockers (warnings are fine)
bun run video:validate    # 0 blockers, 0 warnings
bun run video:verify      # Biome + typecheck + video tests
bun run verify            # repo gates + production build
```

Plus: `video/review/` refreshed, footage commit recorded in two places, and a
conventional commit on its own branch.
