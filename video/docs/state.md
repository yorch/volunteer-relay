# Start here: current state and resume guide

Everything a fresh session needs to re-run and re-record the demo without
rediscovering context. Facts here are a snapshot; every artifact also records its
own provenance (commit, origin, checksum-free manifests) so drift is detectable.

## Snapshot

| Fact                                             | Value                                                                             |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Snapshot taken                                   | 2026-11-08                                                                        |
| Repository                                       | `yorch/volunteer-relay`                                                           |
| HEAD when this was written                       | `3b398ea` (main advanced past the recorded footage)                               |
| **Footage commit** (authoritative for the video) | `42bda8c`, recorded in `generated/capture-manifest.json`                          |
| Capture origin                                   | `local` rehearsal at `http://127.0.0.1:3300` (single origin, never mixed)         |
| Programme                                        | **157.30 s / 4 719 frames @ 30 fps** (`generated/timeline.json`)                  |
| Proof                                            | 18.00 s excerpt of S03 (`video/output/proof.mp4`, copy in `review/`)              |
| Final render                                     | `video/output/final.mp4` = `video/review/final.mp4`, 25.0 MiB                     |
| Final audio                                      | −16.4 LUFS integrated, −4.0 dBTP true peak                                        |
| Narration                                        | ElevenLabs `eleven_multilingual_v2`, one voice, `speed 1.10`, 363 words, 8 scenes |
| Validation                                       | `generated/validation-report.json`: 36 ok / 0 warnings / 0 blockers / 0 skipped   |
| Tests                                            | `video:verify` 82 · `bun run verify` 686 (at snapshot time)                       |
| Toolchain                                        | Node 26.11.1, Bun 1.4.1, Remotion 4.0.541, Playwright 1.65.0                      |

If `HEAD` no longer equals the footage commit, the video is simply **one release
behind the app** — that is expected and documented, not an error. Recapture when
the UI stabilises (see “Recapture because the app moved”).

## Read in this order

1. `AGENTS.md` (repo-wide ownership, git and verification rules)
2. `video/README.md` (workspace layout, commands, data flow)
3. `video/docs/state.md` ← this file
4. `video/docs/decisions.md` (why the cut looks the way it does)
5. `video/docs/recording-runbook.md` (exact commands, checkpoint table, troubleshooting)
6. `video/docs/feature-audit.md` (what the app really does; what the video may claim)
7. `video/docs/readiness-report.md` (status per subsystem, measured numbers)
8. `video/docs/improvement-backlog.md` (known next steps, not yet implemented)
9. `video/docs/setup-checklist.md` + `video/docs/asset-licenses.md` (identities, licences)

## What is finished

- Isolated `video/**` Remotion workspace wired into the Bun workspace, with
  `video:*` scripts, Vitest coverage and Biome/typecheck gates.
- Typed scene manifest → measured timeline → props → render pipeline, with
  validators that fail closed (duration limit, footage length, loudness, captions,
  single origin, final-render identity).
- Synthetic recording scenario reusing the shipped demo profile, with an
  independently authored oracle (`fixtures/expected-results.json`) and checkpoint
  assertions before and after every capture action.
- Eight scenes: designed opening/closing graphics, six product scenes with real
  cursor movement, clicks and typing, provider-aligned captions, heading
  spotlights, callouts, sparse click/confirm accents and origin-anchored punch-ins.
- Real narration, proof render, full render and a committed review copy.

## What is blocked or open

| Item                                         | State                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Hosted capture (`volunteer-relay.brnby.com`) | **blocked** — no dedicated recording credentials exist here; footage stays marked `local` |
| Per-account generated passwords              | **blocked** — needs a scripted seed that accepts a password per identity (other lane)     |
| Second volunteer (Ana) identity              | **blocked** — needs a seed change; S05 uses the same volunteer's later update             |
| Music bed                                    | not implemented — operator chose accents only; needs a licensed asset                     |
| Improvement backlog                          | open, see `docs/improvement-backlog.md`                                                   |
| Live OpenAI/Telegram/SMTP validation         | never executed in this workspace                                                          |

## Environment (names only — never commit values)

`video/.env.local` (0600, git-ignored) holds:

```dotenv
VIDEO_BASE_URL=http://127.0.0.1:3300
VIDEO_TARGET_MODE=local
VIDEO_ALLOWED_ORIGIN=http://127.0.0.1:3300
VIDEO_ORGANIZATION_ID=tidepath
VIDEO_SECONDARY_ORGANIZATION_ID=harbor
VIDEO_SCENARIO_RUN_ID=video-hackathon-tidepath-2026-11
VIDEO_LOCAL_DATABASE_MARKER=relay-video-recording
VIDEO_MARISOL_EMAIL=… VIDEO_MARISOL_PASSWORD=…
VIDEO_OWEN_EMAIL=…     VIDEO_OWEN_PASSWORD=…
VIDEO_SOFIA_EMAIL=…    VIDEO_SOFIA_PASSWORD=…
VIDEO_BOARD_EMAIL=…    VIDEO_BOARD_PASSWORD=…
VIDEO_CASEY_EMAIL=…    VIDEO_CASEY_PASSWORD=…
ELEVENLABS_API_KEY=…   ELEVENLABS_VOICE_ID=…   ELEVENLABS_MODEL_ID=eleven_multilingual_v2
# optional: REMOTION_BROWSER_EXECUTABLE=<path to chrome-headless-shell>
```

The **rehearsal app** additionally needs these exported in the shell that runs
`next dev` (not stored in `video/.env.local`):

```sh
export NODE_ENV=development
export APP_URL=http://127.0.0.1:3300
export DATABASE_URL=postgres://relay:relay@127.0.0.1:55480/relay_video_recording
export ATTACHMENT_ROOT=$PWD/.relay-local/video-attachments
export BETTER_AUTH_SECRET=<32+ chars: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))">
export VIDEO_LOCAL_DATABASE_MARKER=relay-video-recording
export NEXT_TELEMETRY_DISABLED=1
```

`BETTER_AUTH_SECRET` must match what was used when the demo identities were
created; if you recreate the database, either reuse the existing value from
`video/.env.local` (the provisioning script stored one) or regenerate and re-run
provisioning.

## Fixed resource identifiers

| Resource           | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| Compose project    | `relay-video` (`docker compose -p relay-video …`)          |
| Postgres host port | `55480` (`RELAY_POSTGRES_PORT=55480`)                      |
| Recording database | `relay_video_recording` (must end `_video_recording`)      |
| Attachment root    | `.relay-local/video-attachments` (git-ignored)             |
| Rehearsal app port | `3300`                                                     |
| Dev build dir      | `RELAY_NEXT_DIST_DIR=.next-video` (git- and Biome-ignored) |
| Capture viewport   | 2560×1440 recorded → downscaled to 1920×1080               |

## Resume in a fresh session (copy-paste)

```sh
bun install --frozen-lockfile          # if workspace links look stale: bun install --force
cp video/.env.example video/.env.local # fill names above (never commit)

# 1. database
RELAY_POSTGRES_PORT=55480 docker compose -p relay-video start postgres
docker exec relay-video-postgres-1 psql -U relay -d postgres \
  -c "drop database relay_video_recording with (force)"
docker exec relay-video-postgres-1 createdb -U relay relay_video_recording
node packages/db/src/migrate.ts

# 2. app (separate shell; export the block above)
RELAY_NEXT_DIST_DIR=.next-video node apps/web/node_modules/next/dist/bin/next dev \
  apps/web --hostname 127.0.0.1 --port 3300

# 3. scenario → sessions → footage
bun run video:provision     # creates/reuses demo identities, stores missing passwords 0600
bun run video:prepare       # seeds the rich demo profile, verifies the authored baseline
bun run video:auth          # unrecorded sign-in for coordinator/owner/volunteer/board
bun run video:capture -- --fresh

# 4. narration changes → re-time; otherwise reuse the cached audio
bun run video:voice -- --dry-run
bun run video:voice -- --yes            # ONLY if the script/voice changed (billable)
bun run video:timeline

# 5. render + verify
bun run video:proof
bun run video:render
bun run video:validate
bun run video:verify && bun run verify
```

## Recapture because the app moved

```sh
git log --oneline -1                                   # note the new commit
node -e 'console.log(require("./video/generated/capture-manifest.json").appCommit)'  # footage commit
# if they differ and the UI changed:
bun run video:prepare && bun run video:auth && bun run video:capture -- --fresh
bun run video:timeline && bun run video:proof && bun run video:render && bun run video:validate
```

Then refresh `video/review/` (final, proof, scenes, captions, manifests, stills),
update the “Footage commit” rows in `review/README.md` and
`docs/readiness-report.md`, and commit both.

## Facts that must stay in sync

| Pair                                                                   | Rule                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `narration/script.md` ↔ `scenes.json` `narration`                      | Word-for-word; `video:voice` refuses on drift                  |
| `scenes.json` ↔ `fixtures/expected-results.json`                       | Checkpoints must match the actions in `scripts/lib/actions.ts` |
| `fixtures/expected-results.json` ↔ `fixtures/demo/expected-start.json` | Authored by hand; never read back from app output              |
| `scenes.json` annotations ↔ recorded `regions`                         | Annotation `region` ids must exist in the capture manifest     |
| `generated/*` ↔ `review/*`                                             | Review is a frozen copy; refresh after every render            |

## Cleanup (in this order — order matters)

```sh
bun run video:auth:clear                     # optional: drops local sessions
# stop the dev server FIRST, then remove its build dir
rm -rf apps/web/.next-video
RELAY_POSTGRES_PORT=55480 docker compose -p relay-video stop postgres
```

Removing `.next-video` while `next dev` is running kills that server with exit 1 —
harmless for artifacts, but it looks like a failure in logs.
