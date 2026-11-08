# Video workspace

Reproducible production workspace for the Volunteer Relay hackathon video: an
isolated Remotion composition, Playwright capture of genuine application state,
script-only ElevenLabs narration, and validators that refuse to call a render
ready when an asset is missing or the wrong size.

This directory owns `video/**` only. Application code, contracts, migrations and
root manifests stay with their owners; the workspace consumes them.

## What is here

```text
video/
  scenes.json                     typed scene manifest (editorial source of truth)
  narration/script.md             readable narration, must match scenes.json
  narration/pronunciations.json   pronunciation overrides (part of the cache key)
  fixtures/recording-scenario.json  synthetic identities, organizations, checkpoints
  fixtures/expected-results.json    independently authored totals oracle
  src/                            Remotion composition, scenes, components, pure libs
  scripts/                        doctor, provision, prepare, auth, voice, capture,
                                  timeline, validate, preview, render
  docs/                           feature audit, runbook, readiness, licences, checklist
  generated/                      ignored: narration, alignments, captures, captions, manifests
  output/                         ignored: proof, draft and final renders
  .auth/                          ignored: per-role Playwright storage state (0600)
```

## Commands

Run from the repository root with Node 26.11.1; Bun dispatches the scripts.

| Command                                    | What it does                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bun run video:doctor`                     | Read-only readiness report: runtime, tools, manifests, target, credentials present/missing, ignore rules, assets, licence note.     |
| `bun run video:provision`                  | Verify (hosted) or create + verify (local) the recording identities. Never prints or commits a password.                            |
| `bun run video:prepare`                    | Hosted: verify the baseline read-only. Local: migrate and seed a disposable `*_video_recording` database, then verify the baseline. |
| `bun run video:auth`                       | Sign in each capture role in an unrecorded context; write ignored storage state.                                                    |
| `bun run video:auth:clear`                 | Delete only the local auth states.                                                                                                  |
| `bun run video:voice -- --dry-run`         | Validate script/manifest sync, estimate billable characters, show cache hits.                                                       |
| `bun run video:voice`                      | Generate missing narration + alignment with ElevenLabs (`--yes` required for paid calls).                                           |
| `bun run video:voice -- --audio-dir <dir>` | Import supplied `S01.mp3…S08.mp3` instead of ElevenLabs.                                                                            |
| `bun run video:voice -- --scratch`         | Local timing voice, labelled `scratch-local-voice`. Never final narration.                                                          |
| `bun run video:capture -- --scene S04`     | Capture and assert one scene.                                                                                                       |
| `bun run video:capture`                    | Capture all product scenes in manifest order, asserting checkpoints.                                                                |
| `bun run video:timeline`                   | Build frame timings and captions from measured assets.                                                                              |
| `bun run video:preview`                    | Remotion Studio with the measured timeline.                                                                                         |
| `bun run video:proof`                      | Render the 18-second proof excerpt.                                                                                                 |
| `bun run video:render -- --draft`          | Half-scale draft of the full programme.                                                                                             |
| `bun run video:render`                     | Full-resolution render when narration is final.                                                                                     |
| `bun run video:validate`                   | Validate manifests, media, captions, duration, output loudness.                                                                     |
| `bun run video:verify`                     | Biome, project typecheck and the video unit tests.                                                                                  |

Bun needs `--` before video-specific flags: `bun run video:capture -- --scene
S04`. Node's native type stripping runs the scripts, so `node
video/scripts/doctor.ts` works too.

## Delivery targets

1920×1080, 30 fps, H.264 (yuv420p, bt709), AAC, ≤ 180 s, SRT captions, −16 LUFS
integrated, true peak ≤ −1 dBTP. The scene floor currently plans 162.3 s with the
scratch voice; final duration follows measured narration.

## Hard rules encoded in the tooling

- Hosted capture is the default; local rehearsal needs `VIDEO_TARGET_MODE=local`
  and refuses non-loopback hosts.
- Credentials are only submitted to `VIDEO_ALLOWED_ORIGIN`; authentication runs
  in an unrecorded context with no video, trace, HAR or response logging.
- Runtime preparation never deletes hosted data and never resets a database that
  is not a disposable `*_video_recording` one.
- Every product scene asserts the authored checkpoint totals before and after
  its action; a failed assertion aborts the take.
- A render reports missing footage or narration instead of substituting it, and
  the timeline refuses footage shorter than its scene.
- `video:render` refuses a final render unless the audio on disk is final and
  matches the timeline, every narrated scene has captions, every product scene is
  captured and all footage comes from one origin; `final.mp4` is reserved for that
  render, and a mixed-origin capture set is rejected before capture starts.
- Paid narration skips cached scenes and persists each completed scene, so a
  failure never re-bills a finished scene.
- Authentication locks the browser context to the allowed origin before typing a
  credential; storage state is written into a private directory through a
  0600 temporary file.
- Captions come from provider character alignment; supplied audio without
  alignment is labelled `proportional-phrase`.
