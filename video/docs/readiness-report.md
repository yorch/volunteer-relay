# Readiness report

Date: 2026-11-08. Repository: `yorch/volunteer-relay`, branch `agents/A-video`,
base `00dfa71`. Node 26.11.1, Bun 1.4.1. All numbers below are measured in this
workspace; nothing is copied from an implementation claim.

## Subsystem status

| Subsystem                              | Status                     | Evidence and limits                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application scenario (hosted)          | **blocked**                | `https://volunteer-relay.brnby.com/api/health` and `/api/ready` return 200 (`runtime: 26.11.1`), but no recording-account credentials exist here, so nothing was provisioned or recorded hosted. The deployment exposes no build id or commit → the deployed release is **unknown**.                                                                                                                                |
| Application scenario (local rehearsal) | **ready**                  | Disposable PostgreSQL `relay_video_recording` (Compose project `relay-video`, port 55480), migrations, synthetic demo seed. Authored baseline verified from the app: **180 approved minutes, 3 contributions, 7 awaiting review, 10 sources, 4 open needs, 1 resolved, 1 pending unknown duration** — matches `fixtures/expected-results.json`; `fixtures/demo/expected-start.json` is the manual oracle behind it. |
| Captures                               | **ready-with-limitations** | Six product scenes captured at 1920×1080 from the local rehearsal target: S02 23.33 s, S03 23.37 s, S04 27.23 s, S05 21.37 s, S06 23.40 s, S07 23.40 s, all H.264 yuv420p 30 fps. Every take asserted the starting and resulting checkpoint; S04 → 300 approved minutes / 5 contributions / 3 activities; S05 → unchanged; S06 → urgent need acknowledged. Limitation: local origin only, no hosted footage.        |
| Narration                              | **blocked**                | No `ELEVENLABS_API_KEY`/voice. `video:voice --dry-run` validates the 377-word draft (350–390 target) and estimates 2 352 characters; nothing was billed. A local scratch voice (`say`, labelled `scratch-local-voice`) provided real audio for timing and the proof only. It is not final narration.                                                                                                                |
| Captions                               | **ready-with-limitations** | 68 phrase-level cues, max two lines, inside the programme, SRT exported. Limitation: derived by proportional phrase timing from the scratch audio (`proportional-phrase`), not provider character alignment. Provider alignment parsing itself is unit-tested.                                                                                                                                                      |
| Composition                            | **ready**                  | Frame-based sequences from the generated timeline: 162.30 s, 4 869 frames at 30 fps, integer boundaries, contiguous, under the 180 s limit. Product scenes use genuine captures with labelled origin; graphics are designed and labelled.                                                                                                                                                                           |
| Final render                           | **ready-with-limitations** | The pipeline is wired end to end and the proof renders. The full programme is not rendered because final narration does not exist; `bun run video:render` is the one command waiting on it.                                                                                                                                                                                                                         |

## Proof render

`video/output/proof.mp4` — 18.00 s excerpt of S03 (real capture + real audio +
burned-in captions).

- 1920×1080, 30.00 fps, H.264 (yuv420p, tv range, bt709), AAC 48 kHz stereo.
- Loudness: **−16.9 LUFS integrated**, **−5.6 dBTP** true peak (targets −16 LUFS,
  ≤ −1 dBTP).
- Size 1.6 MiB; rendered with Remotion 4.0.541 using the cached Playwright Chrome
  Headless Shell.
- Representative frames inspected at 1 s, 9 s and 16 s: real inbox UI, correct
  per-scene captions after the cue-rebasing fix, disclosure reads
  "Synthetic demo data · local capture".
- Audio was measured, not listened to: this environment cannot audit the
  performance quality of the scratch voice. Treat the audio as a timing probe.

## Verification results

- `bun run video:verify` — Biome clean (1 warning-level rule in a test), project
  typecheck clean, **50 video unit tests passing** (manifest schema, frame
  arithmetic, duration limits, caption grouping/validation/SRT, alignment
  parsing, cache identity, checkpoint comparison, target guard, env parsing).
- `bun run video:validate` — 30 pass, 2 warnings (scratch narration provenance,
  proportional caption provenance), 0 blockers, 1 skip (final render not
  requested).
- Repository `bun run verify` — see the handoff section; results are recorded in
  the PR description after the gate run.

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
