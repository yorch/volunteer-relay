# Decision log

Why the video is the way it is. Each entry records the choice, the reason, the
consequence, and what would reverse it. Dates are 2026-11-08 unless noted.

## D1 — Reuse the shipped demo dataset instead of inventing a recording seed

- **Decision:** capture the synthetic profile already in `packages/db/src/demo-data.ts`
  (Tidepath Mutual Aid / Harbor Neighbour Network, `demo-*@example.invalid`,
  one intentional public demo password) rather than a new “Tidepath Family
  Alliance — Recording” tenant with per-account generated passwords.
- **Why:** that dataset is seeded, tested and has a manual oracle
  (`fixtures/demo/expected-start.json`). A new tenant/identity seed is a domain
  change owned by another lane; inventing one for a video would risk untested
  data and duplicate the auth surface.
- **Consequence:** the brief's requested org names/identity list are mapped in
  `docs/setup-checklist.md`, including the gaps (no Ana account, no Casey-style
  volunteer in the second tenant, no per-identity passwords).
- **Reverse if:** a scripted seed that accepts a password per identity lands.

## D2 — Local-first capture, with a hard single-origin rule

- **Decision:** all footage is recorded from a disposable local rehearsal
  (`http://127.0.0.1:3300`, database `relay_video_recording`) and labelled
  `local` everywhere; hosted capture is supported but blocked without dedicated
  recording credentials.
- **Why:** the deployed origin is healthy but exposes no build id and no accounts
  were supplied. Mixing local and hosted shots in one delivery would misrepresent
  a release.
- **Consequence:** `capture.ts` refuses to continue when the existing manifest
  came from a different base URL; `validate.ts` blocks mixed origins.
- **Reverse if:** recording accounts exist on the deployment and the hosted org
  matches the authored baseline (`video:prepare` fails closed otherwise).

## D3 — Narration: one stock ElevenLabs voice at `speed 1.10`

- **Decision:** `eleven_multilingual_v2`, one voice, one settings set, `speed 1.10`
  (~142 wpm), 363-word draft (target 350–390), no cloning.
- **Why:** the first cut read at 129 wpm and felt slow; 1.10 recovered ~19 s of
  runtime and energy without sounding rushed. 1.16 was offered and declined
  (kept as an option in the backlog).
- **Consequence:** audio is billable per generation; only cache misses are
  requested. Timing changes require `video:timeline` afterwards.
- **Reverse if:** a different voice is preferred (re-run `video:voice -- --force`).

## D4 — Loudness normalised in the render path, per scene

- **Decision:** measure each narration file (EBU R128), apply a per-scene gain to
  −16 LUFS, add an `alimiter` when the gain would exceed −1 dBTP.
- **Why:** the real voice measured −22.9 LUFS programme; a flat lift clipped at
  +2 dBTP, and a single programme-wide gain left excerpts (the proof) off target.
- **Consequence:** `generated/narration-mix/` holds normalised copies; originals
  are never rewritten. Final measures −16.4 LUFS / −4.0 dBTP.
- **Reverse if:** the mix is handed to an external editor.

## D5 — Real interactions instead of faked success states

- **Decision:** every product scene performs genuine actions with a visible DOM
  cursor, real mouse events, click ripples and real typing; state changes are
  persisted and asserted against the oracle.
- **Why:** the earlier cut looked like annotated screenshots. Judges need to see
  the workflow move.
- **Consequence:** captures take longer and are more fragile (elements must be in
  view); the capture viewport is 2560×1440 downscaled to 1080p so panes fit
  without scrolling.
- **Reverse if:** never — faking application state is out of scope by design.

## D6 — Spotlights only on page-level headings

- **Decision:** annotation highlights are enabled for the page heading only;
  inner-element boxes (source text, contribution rows, need card) are disabled.
- **Why:** the workspace scrolls its three panes independently, so a box measured
  at one moment drifts off its target seconds later (observed twice). Headings sit
  outside every scroll container and stay put.
- **Consequence:** less precision on the “two volunteers” beat; the callout and
  the S04 evidence drill-down carry that argument instead.
- **Reverse if:** takes can be choreographed scroll-free (backlog item).

## D7 — Punch-ins are origin-anchored, never translated

- **Decision:** zoom uses `transform-origin` at the focus point with scale only.
- **Why:** translating a full-frame video exposes the frame edge; centring a
  left-side point mathematically needs a 1.67× scale. The first implementation
  produced a dark band and off-centre spotlights.
- **Consequence:** subject stays where it is and the frame grows around it;
  `focus-transform.ts` is shared by footage and the annotation layer and is
  unit-tested.
- **Reverse if:** a larger crop budget is acceptable.

## D8 — On-screen fictional-data wording removed

- **Decision:** product scenes carry no synthetic-data pill; S01's “illustrative
  reenactment” and S03's “prepared demo proposal” labels were also removed at the
  operator's request. Only the closing “AI narration · MIT licensed” line remains.
- **Why:** operator preference for a cleaner, more product-like presentation.
- **Consequence:** provenance lives in the manifests and docs, not on screen.
  Reviewers who need disclosure must read `docs/feature-audit.md`.
- **Reverse if:** a submission requires on-screen synthetic-data disclosure.

## D9 — S04 shows the visit's evidence instead of the raw ledger list

- **Decision:** after accepting, the take clicks “Inspect current source evidence”
  on the garden visit.
- **Why:** the ledger lists contributions, so three “visit” rows read as
  duplicated records and undercut S05's “no double counting” claim.
- **Consequence:** S04 ends on source + records together; an extra marker
  (`evidence-opened`) exists in the capture manifest.

## D10 — Review media is committed (≈32 MB)

- **Decision:** `video/review/` keeps final, proof, six scene clips, captions,
  manifests and stills in git.
- **Why:** anyone can clone and watch without running the toolchain; the operator
  preferred this over gitignoring renders.
- **Consequence:** repository growth on every refresh; refresh is a manual copy
  step documented in `state.md`.

## D11 — Sparse UI accents, no music bed

- **Decision:** two locally synthesised accents (click, confirm) fired from real
  action markers; no music.
- **Why:** accents lift the interaction beats with zero licensing risk; a music
  bed needs a licensed asset the operator has not supplied.
- **Consequence:** `scripts/lib/accents.ts` synthesises the WAV/MP3s on demand;
  `accentCues()` caps cues so the track stays quiet.
- **Reverse if:** a licensed track is supplied (duck to ~−28 LUFS under speech).
