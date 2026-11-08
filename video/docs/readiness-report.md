# Readiness report

Date: 2026-11-08. Repository: `yorch/volunteer-relay`, branch `agents/A-video`,
base `00dfa71`. Node 26.11.1, Bun 1.4.1. All numbers below are measured in this
workspace; nothing is copied from an implementation claim.

## Subsystem status

| Subsystem                              | Status                     | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application scenario (hosted)          | **blocked**                | `https://volunteer-relay.brnby.com/api/health` and `/api/ready` return 200 (`runtime: 26.11.1`), but no recording-account credentials exist here, so nothing was provisioned or recorded hosted. The deployment exposes no build id or commit → the deployed release is **unknown**.                                                                                                                                |
| Application scenario (local rehearsal) | **ready**                  | Disposable PostgreSQL `relay_video_recording` (Compose project `relay-video`, port 55480), migrations, synthetic demo seed. Authored baseline verified from the app: **180 approved minutes, 3 contributions, 7 awaiting review, 10 sources, 4 open needs, 1 resolved, 1 pending unknown duration** — matches `fixtures/expected-results.json`; `fixtures/demo/expected-start.json` is the manual oracle behind it. |
| Captures                               | **ready-with-limitations** | Six product scenes at app commit `ad67785`, recorded at 2560×1440 and downscaled to 1920×1080 (workspace fits without scrolling): S02 23.93 s, S03 22.40 s, S04 25.00 s, S05 17.80 s, S06 25.63 s, S07 23.37 s, H.264 yuv420p 30 fps. Real cursor, clicks and typing are visible; origin is local only.                                                                                                             |
| Narration                              | **ready**                  | ElevenLabs `eleven_multilingual_v2`, one voice, `speed 1.10` (~142 wpm), 363-word draft, 8 scenes, per-scene alignment retained; only cache misses are requested.                                                                                                                                                                                                                                                   |
| Captions                               | **ready**                  | 68+ phrase-level cues derived from provider character alignment (no proportional fallback), max two lines, exported as SRT.                                                                                                                                                                                                                                                                                         |
| Composition                            | **ready**                  | 157.30 s / 4 719 frames at 30 fps: two punch-ins per product scene, callouts, alignment captions, sparse click/confirm accents tied to action markers; 22.7 s under the limit.                                                                                                                                                                                                                                      |
| Final render                           | **ready**                  | Rendered: 157.30 s, 1920×1080, 30 fps, H.264 yuv420p/bt709, AAC 48 kHz, 24.4 MiB, −16.4 LUFS, −4.0 dBTP. `video:validate` 36 ok / 0 warnings / 0 blockers. Copy at `video/review/final.mp4`.                                                                                                                                                                                                                        |

## Proof render

`video/output/proof.mp4` — 18.00 s excerpt of S03 (real capture + real audio +
burned-in captions).

- 1920×1080, 30.00 fps, H.264 (yuv420p, tv range, bt709), AAC 48 kHz stereo.
- Loudness: **−16.4 LUFS integrated**, **−4.2 dBTP** true peak (targets −16 LUFS,
  ≤ −1 dBTP).
- Size 1.6 MiB; rendered with Remotion 4.0.541 using the cached Playwright Chrome
  Headless Shell.
- Representative frames inspected at 1 s, 9 s and 16 s: real inbox UI, correct
  per-scene captions after the cue-rebasing fix, disclosure reads
  "Synthetic demo data · local capture".
- Audio was measured, not listened to: this environment cannot audit the
  performance quality of the scratch voice. Treat the audio as a timing probe.

## Verification results

Snapshot at footage commit `42bda8c` (see
[`state.md`](state.md) for the live snapshot; the app may have moved since):

- `bun run video:verify` — Biome clean, project typecheck clean, **82 video unit
  tests passing** (manifest schema, frame arithmetic, duration limits, caption
  grouping/validation/SRT, alignment parsing, cache identity and cache-miss
  planning, binary audio writes, database guard, final-render readiness, focus
  transform, accent mapping, checkpoint comparison, target guard, env parsing,
  argument parsing).
- `bun run video:validate` — **36 ok, 0 warnings, 0 blockers, 0 skipped**,
  including final-render identity, full-programme duration and loudness.
- Repository `bun run verify` — Biome clean, strict typecheck, **686 tests**,
  production build, exit 0.
- Measurement snapshot: programme 157.30 s / 4 719 frames @ 30 fps; final
  1920×1080 H.264 yuv420p/bt709 + AAC, 25.0 MiB, −16.4 LUFS, −4.0 dBTP.

A frozen copy of the reviewable media (final, proof, six scene clips, captions,
manifests, QA stills) lives in [`video/review/`](../review/README.md) with its
provenance; it is committed evidence, not a build input.

## Adversarial review hardening

An independent adversarial review of the first PR revision found real defects;
this revision fixes them:

- Provisioning now shares preparation's disposable-database guard, so public
  demo-password identities cannot be written to an ordinary or remote database.
- Provider audio is written as bytes (a UTF-8 text write corrupted MP3 data).
- Paid narration requests only cache misses and persists each finished scene.
- A full render is gated on the audio actually on disk (not only the saved
  timeline): final narration durations must match the timeline, every narrated
  scene needs captions, every product scene needs a capture and one origin.
  `final.mp4` is reserved for that validated full render; proof/draft/scene
  renders cannot write it, and `video:validate` checks the render's identity and
  full-programme duration.
- Each capture asset records its exact base URL and origin; a subset recapture
  from another target is refused, and the composition labels every scene from its
  own asset.
- Authentication locks the browser context to the allowed origin before the
  password is typed and writes storage state through a 0600 temporary file in a
  0700 directory.
- Supplied or scratch audio invalidates stale provider alignment; captions fall
  back to labelled proportional phrase timing.
- Captures normalise into a staged mezzanine, verify 1920×1080, then replace the
  accepted file; each take publishes its manifest entry, and failed takes clean up
  after the browser closes (so a finalising recording cannot race the sweep).
- A malformed `video/.env.local` is now an error instead of silently discarding
  target/tenant settings.
- Capture holds are narration-aware: the take runs until the measured narration
  plus tail fits, so real narration cannot outrun its footage.
- The render path normalises narration per scene to −16 LUFS (duration-weighted
  measurement) and inserts a true-peak limiter when the gain would clip; the proof
  measures −16.4 LUFS / −4.2 dBTP.
- `video:provision` fills blank placeholders in place (including the isolation
  identity), replaces the last duplicate assignment, preserves existing values and
  fails when a required role stays unverified.
- `VIDEO_ORGANIZATION_ID` / `VIDEO_SECONDARY_ORGANIZATION_ID` now override the
  committed scenario for authentication and assertions.
- On-screen fictional-data wording was removed at the operator's request (D8 in
  [`decisions.md`](decisions.md)); provenance stays in the manifests and docs.
- Env parsing rejects malformed quoting and handles quoted values with trailing
  comments; `parseArgs` no longer duplicates a flag value as a positional.

## Known limitations and manual checks remaining

1. **No hosted footage.** Supply dedicated hosted recording credentials and rerun
   `video:prepare` → `video:auth` → `video:capture` against
   `https://volunteer-relay.brnby.com`, then relabel the manifests. Never mix
   origins.
2. **No final narration.** Add ElevenLabs configuration, run
   `bun run video:voice -- --yes`, `bun run video:timeline`, then `video:render`.
   Re-check total duration: the final voice is slower than the scratch voice, so
   the programme will grow from 162.3 s and must stay under 180 s.
3. **Captions must be re-derived** from the provider alignment once narration is
   real; the current cues are proportional.
4. **Hosted baseline is unverified.** The local baseline is proven; the deployed
   organization may hold different records. `video:prepare` fails closed on a
   mismatch and never resets hosted data.
5. **Demo-proposal honesty.** S03 shows authored synthetic proposals, not a live
   model response. No live OpenAI, SMTP or Telegram call was made here.
6. **Escalation is narrated, not captured.** No clock change and no simulated
   deadline; the worker code path exists.
7. **Licence input required.** Remotion is source-available, free only for
   individuals, teams of up to three, and non-profits; confirm eligibility before
   commercial publication (see `asset-licenses.md`).
8. **Second volunteer missing.** Ana's later duplicate report is authored by the
   same synthetic volunteer; a second volunteer identity needs a seed change.

## Reproduction commands (local)

```sh
RELAY_POSTGRES_PORT=55480 docker compose -p relay-video up -d postgres
docker exec relay-video-postgres-1 createdb -U relay relay_video_recording
# export DATABASE_URL, ATTACHMENT_ROOT, BETTER_AUTH_SECRET, APP_URL,
#   NODE_ENV=development, VIDEO_LOCAL_DATABASE_MARKER=relay-video-recording
node packages/db/src/migrate.ts
bun run video:provision
node apps/web/node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 3300
bun run video:prepare
bun run video:auth
bun run video:capture
bun run video:voice -- --scratch      # or real narration
bun run video:timeline
bun run video:proof
bun run video:validate
```
