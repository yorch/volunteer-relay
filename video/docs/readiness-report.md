# Readiness report

Per-subsystem status for the current cut. Numbers are measured, never copied from
a request or a commit message. The live snapshot (footage commit, test counts,
resource ids) is [`state.md`](state.md); this page judges each subsystem, and
[`decisions.md`](decisions.md) records why the cut looks the way it does.

Measurements below correspond to the artefacts in `generated/` and `review/`
(programme 157.30 s, final −16.4 LUFS / −4.0 dBTP). Re-run `bun run video:validate`
after any render; the committed copy of that report is in `review/manifests/`.

## Subsystem status

| Subsystem                              | Status                     | Evidence                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application scenario (hosted)          | **blocked**                | `/api/health` and `/api/ready` answer 200 (`runtime: 26.11.1`), but no dedicated recording credentials exist here and the deployment exposes no build id. Nothing was provisioned or recorded hosted.                                                                                                                                      |
| Application scenario (local rehearsal) | **ready**                  | Disposable `relay_video_recording` database, migrations, rich demo seed. The authored baseline is verified from the app: 180 approved minutes, 3 contributions, 7 awaiting review, 10 sources, 4 open needs, 1 resolved, 1 pending unknown duration.                                                                                       |
| Captures                               | **ready-with-limitations** | Six product scenes recorded at 2560×1440 and downscaled to 1920×1080, all H.264 yuv420p 30 fps, single `local` origin, per-scene `appCommit` recorded. Real cursor, clicks and typing; S04 ends by opening the visit's original evidence. Checkpoints asserted before and after every action. Limitation: not the hosted release.          |
| Narration                              | **ready**                  | ElevenLabs `eleven_multilingual_v2`, one voice, `speed 1.10` (~142 wpm), 363-word draft, 8 scenes, per-scene alignment retained. `video:voice` requests cache misses only.                                                                                                                                                                 |
| Captions                               | **ready**                  | Phrase-level cues derived from provider character alignment (no proportional fallback), max two lines, burned in and exported as SRT.                                                                                                                                                                                                      |
| Composition                            | **ready**                  | 157.30 s / 4 719 frames at 30 fps: origin-anchored punch-ins (never exposing the frame edge), heading spotlights, callouts, sparse click/confirm accents tied to action markers. 22.7 s under the limit.                                                                                                                                   |
| Final render                           | **ready**                  | 1920×1080, 30 fps, H.264 yuv420p/bt709, AAC 48 kHz, 25.0 MiB, −16.4 LUFS, −4.0 dBTP. The render gate requires real narration, on-disk durations matching the timeline, captions for every narrated scene, every product scene captured and a single origin; `final.mp4` is reserved for that validated render. Copy at `review/final.mp4`. |

## Verification

- `bun run video:validate` — **36 ok, 0 warnings, 0 blockers, 0 skipped**,
  including final-render identity, full-programme duration and loudness.
- `bun run video:verify` — Biome, project typecheck, video unit tests (run to see
  the current count; `state.md` snapshots it).
- `bun run verify` — repo Biome, strict typecheck, repo tests, production build.

## Honest limitations

1. **No hosted footage.** Supply dedicated recording credentials and rerun
   prepare → auth → capture against `volunteer-relay.brnby.com`; never mix origins.
2. **Local caches only.** `generated/` is git-ignored: a fresh clone must regenerate
   narration (billable) and re-capture before it can render.
3. **Demo proposals are authored fixtures** in the review queue, not live model
   output, and no live OpenAI/Telegram/SMTP call was made here. The narration says
   "Relay proposes"; it does not claim a specific model version.
4. **Escalation is narrated, not filmed.** No clock change and no simulated
   deadline; the worker path exists (`follow-through.ts`).
5. **Spotlights cover page headings only.** Inner panes scroll independently, so
   inner-element boxes drift; see D6.
6. **On-screen fictional-data wording was removed** at the operator's request (D8).
   Provenance lives in manifests, `feature-audit.md` and this page.
7. **Licence input required.** Remotion is source-available, not MIT; confirm
   eligibility before commercial publication (`asset-licenses.md`).
8. **App churn.** The deployed/current app may be ahead of the footage commit;
   compare `review/manifests/capture-manifest.json` `appCommit` with `HEAD`.
