# Start here: current state and resume guide

Everything a fresh session needs to re-run and re-record the demo without
rediscovering context. Every artifact records its own provenance, so drift is
detectable.

> Secret hygiene: never `grep -r video/` without `--exclude-dir=.auth` and
> `--exclude=.env.local`. Those paths hold live local credentials; a broad grep
> will print them into a session transcript.

## Snapshot

| Fact                               | Value                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Snapshot taken                     | 2026-11-08                                                                                             |
| Repository                         | `yorch/volunteer-relay`                                                                                |
| **Footage commit** (authoritative) | the `appCommit` field of `video/review/manifests/capture-manifest.json` (= `42bda8c` at snapshot time) |
| Capture origin                     | `local` rehearsal at `http://127.0.0.1:3300` (single origin, never mixed)                              |
| Programme                          | **157.30 s / 4 719 frames @ 30 fps** (`generated/timeline.json`)                                       |
| Proof                              | 18.00 s excerpt of scene `S03` (`video/output/proof.mp4`)                                              |
| Final render                       | `video/output/final.mp4` = `video/review/final.mp4`, 25.0 MiB                                          |
| Final audio                        | −16.4 LUFS integrated, −4.0 dBTP true peak                                                             |
| Narration                          | ElevenLabs `eleven_multilingual_v2`, voice id in `ELEVENLABS_VOICE_ID`, `speed 1.10`, 363 words        |
| Validation                         | 36 ok / 0 warnings / 0 blockers / 0 skipped                                                            |
| Tests                              | `video:verify` 82 · `bun run verify` (repo) see the log at run time                                    |
| Toolchain                          | Node 26.11.1, Bun 1.4.1, Remotion 4.0.541, Playwright 1.65.0                                           |

`HEAD` is normally **ahead** of the footage commit (other lanes keep changing the
app). That is expected: the video is one release behind, and the capture manifest
says exactly which one. Do not infer the footage commit from commit messages —
history contains a video commit whose _message_ mentions a UI change while the
footage it committed was recorded earlier.

## Read in this order

1. `AGENTS.md` (ownership, git and verification rules)
2. `video/README.md` (layout, commands, data flow)
3. `video/docs/state.md` ← this file
4. `video/docs/decisions.md` (why the cut looks the way it does)
5. `video/docs/recording-runbook.md` (commands, checkpoints, troubleshooting)
6. `video/docs/feature-audit.md` (what the app really does; what the video may claim)
7. `video/docs/readiness-report.md` (status per subsystem)
8. `video/docs/improvement-backlog.md` (known next steps)
9. `video/docs/setup-checklist.md`, `video/docs/asset-licenses.md`
10. `video/docs/kickoff.md` (only when starting a _new_ video)

## What is finished

- Isolated `video/**` Remotion workspace with `video:*` scripts, Vitest coverage and
  Biome/typecheck gates.
- Typed scene manifest → measured timeline → props → render, with validators that
  fail closed (duration, footage length, loudness, captions, single origin, final
  render identity).
- Synthetic recording scenario on the shipped demo profile, with a hand-authored
  oracle and checkpoint assertions before/after every capture action.
- Eight scenes with real cursor/clicks/typing, provider-aligned captions, heading
  spotlights, callouts, click/confirm accents and origin-anchored punch-ins.
- Real narration, proof, full render and a committed review copy.

## What is blocked or open

| Item                                         | State                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Hosted capture (`volunteer-relay.brnby.com`) | **blocked** — no dedicated recording credentials; footage stays `local`                                                    |
| Per-account generated passwords              | blocked — needs a scripted seed that accepts a password per identity                                                       |
| Second volunteer (Ana) identity              | blocked — needs a seed change                                                                                              |
| Music bed                                    | not implemented (accents only) — needs a licensed asset                                                                    |
| Live OpenAI/Telegram/SMTP checks             | never executed here                                                                                                        |
| `VIDEO_OPERATOR_*`, `VIDEO_ANA_*`            | intentionally unset; `video:doctor` warns about them because the brief asked for identities the demo profile does not have |
| Improvement backlog                          | open — `docs/improvement-backlog.md`                                                                                       |

## Environment: one file, sourced in every shell

`video/.env.local` (0600, git-ignored) holds **both** the video variables and the
local rehearsal app variables, so a single `source` makes `migrate`,
`video:provision`, `video:prepare`, `video:auth`, `video:capture` and `next dev`
see the same configuration. `video:scripts` also parse this file directly; the
`source` is what makes `process.env` see it for the app, migrations and seeds.

```dotenv
# capture target
VIDEO_BASE_URL=http://127.0.0.1:3300
VIDEO_TARGET_MODE=local
VIDEO_ALLOWED_ORIGIN=http://127.0.0.1:3300
VIDEO_ORGANIZATION_ID=tidepath
VIDEO_SECONDARY_ORGANIZATION_ID=harbor
VIDEO_SCENARIO_RUN_ID=video-hackathon-tidepath-2026-11
VIDEO_LOCAL_DATABASE_MARKER=relay-video-recording

# local rehearsal app (also required by migrate / seed, not only by next dev)
NODE_ENV=development
APP_URL=http://127.0.0.1:3300
DATABASE_URL=postgres://relay:relay@127.0.0.1:55480/relay_video_recording
ATTACHMENT_ROOT=./.relay-local/video-attachments
BETTER_AUTH_SECRET=            # generate: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
NEXT_TELEMETRY_DISABLED=1

# recording identities (role → env mapping below)
VIDEO_MARISOL_EMAIL=…          VIDEO_MARISOL_PASSWORD=…   # owner
VIDEO_OWEN_EMAIL=…             VIDEO_OWEN_PASSWORD=…      # coordinator
VIDEO_SOFIA_EMAIL=…            VIDEO_SOFIA_PASSWORD=…     # volunteer
VIDEO_BOARD_EMAIL=…            VIDEO_BOARD_PASSWORD=…     # report-reader
VIDEO_CASEY_EMAIL=…            VIDEO_CASEY_PASSWORD=…     # multi-organization (second tenant)

# narration
ELEVENLABS_API_KEY=…
ELEVENLABS_VOICE_ID=…
ELEVENLABS_MODEL_ID=eleven_multilingual_v2
# optional: REMOTION_BROWSER_EXECUTABLE=/path/to/chrome-headless-shell
```

Role → variable mapping is fixed in `fixtures/recording-scenario.json`
(`MARISOL` = owner, `OWEN` = coordinator, `SOFIA` = volunteer, `BOARD` =
report-reader, `CASEY` = multi-organization). Leave the emails blank in
`.env.example` and let `video:provision` fill them in local mode; hard-coded
`relay.*@example.com` addresses will _not_ sign in, because the demo identities
are `demo-*@example.invalid`.

`BETTER_AUTH_SECRET` protects sessions and is read by `apps/web` and the seed; it
does **not** affect stored password hashes, so rotating it signs everyone out but
does not break existing accounts. Use one value for the life of the database.

## Fixed resource identifiers

| Resource           | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| Compose project    | `relay-video`                                              |
| Postgres host port | `55480` (`RELAY_POSTGRES_PORT=55480`)                      |
| Recording database | `relay_video_recording` (must end `_video_recording`)      |
| Attachment root    | `.relay-local/video-attachments` (git-ignored)             |
| Rehearsal app port | `3300`                                                     |
| Dev build dir      | `RELAY_NEXT_DIST_DIR=.next-video` (git- and Biome-ignored) |
| Capture viewport   | 2560×1440 recorded → downscaled to 1920×1080               |

## Resume in a fresh session (run top to bottom)

```sh
# 0. dependencies (a stale link can make tsc miss @relay/* packages)
bun install --frozen-lockfile      # if resolution looks stale: bun install --force

# 1. configuration: copy the template and fill it (never commit)
cp video/.env.example video/.env.local && chmod 600 video/.env.local
mkdir -p .relay-local/video-attachments

# 2. export the same file into every shell you use, including the app shell
set -a; . video/.env.local; set +a

# 3. database (fresh machine: `up -d`; dropping a previous run is explicit)
RELAY_POSTGRES_PORT=55480 docker compose -p relay-video up -d postgres
docker exec relay-video-postgres-1 psql -U relay -d postgres \
  -c "drop database if exists relay_video_recording with (force)"
docker exec relay-video-postgres-1 createdb -U relay relay_video_recording
node packages/db/src/migrate.ts

# 4. app FIRST — provision, prepare, auth and capture all talk to it over HTTP
RELAY_NEXT_DIST_DIR=.next-video node apps/web/node_modules/next/dist/bin/next dev \
  apps/web --hostname 127.0.0.1 --port 3300
#    wait for: curl -sf http://127.0.0.1:3300/api/health

# 5. scenario → sessions → footage (second shell, sourced again)
bun run video:provision     # creates/reuses demo identities, stores missing passwords 0600
bun run video:prepare       # seeds the rich demo profile, verifies the authored baseline
bun run video:auth          # unrecorded sign-in for each capture role
bun run video:capture -- --fresh

# 6. narration: reuse the local cache, or regenerate (billable) if the script changed
bun run video:voice -- --dry-run
bun run video:voice -- --yes        # ask before spending money
bun run video:timeline

# 7. render — `video:render` LAST before validate (it owns render-report.json)
bun run video:proof
bun run video:render
bun run video:validate

# 8. gates
bun run video:verify && bun run verify
```

> `video/generated/` is **local to this checkout** (git-ignored). A fresh clone has
> no narration MP3s, alignments or captures: step 6 costs one narration run
> (~2 254 characters) and step 5 one capture pass. Re-run with the same
> `ELEVENLABS_VOICE_ID` and the same script to keep the voice consistent;
> otherwise supply audio with `bun run video:voice -- --audio-dir <dir>`.
> The ~10-minute figure only applies when that cache already exists.

## Recapture because the app moved

Each capture pass mutates the demo data to the final checkpoint, so **recreate the
database** before recapturing — `video:prepare` reseeds but never resets.

```sh
git rev-parse --short HEAD
node -e 'console.log(require("./video/generated/capture-manifest.json").appCommit)'
# differs and the UI changed → recapture against a clean baseline:

set -a; . video/.env.local; set +a
docker exec relay-video-postgres-1 psql -U relay -d postgres \
  -c "drop database if exists relay_video_recording with (force)"
docker exec relay-video-postgres-1 createdb -U relay relay_video_recording
node packages/db/src/migrate.ts
bun run video:prepare && bun run video:auth
bun run video:capture -- --fresh
bun run video:timeline && bun run video:proof && bun run video:render && bun run video:validate
```

Keep the worker stopped during capture: escalation consumes acknowledgement
deadlines, and the video never simulates elapsed time.

## Refresh the committed review copy

```sh
cp video/output/final.mp4  video/review/final.mp4
cp video/output/proof.mp4  video/review/proof.mp4
cp video/generated/captures/S0*.mp4 video/review/scenes/
cp video/generated/captions/captions.json video/generated/captions/captions.srt \
   video/review/captions/
cp video/generated/capture-manifest.json video/generated/timeline.json \
   video/generated/render-report.json video/generated/validation-report.json \
   video/review/manifests/
for t in 1 9 16; do
  ffmpeg -hide_banner -loglevel error -y -ss "$t" -i video/output/proof.mp4 \
    -frames:v 1 "video/review/stills/frame-$(printf '%02d' "$t")s.png"
done

# never `git add -A`: the checkout may contain other lanes' untracked renders
git add video/review video/docs video/README.md
git commit -m "chore(video): refresh review media"
```

Then update two rows only, from the manifests (not from memory):
`video/review/README.md` “Footage commit” and
`video/docs/readiness-report.md` “Footage commit”.

## Facts that must stay in sync

| Pair                                                                                    | Rule                                                |
| --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `narration/script.md` ↔ `scenes.json` `narration`                                       | word-for-word; `video:voice` refuses on drift       |
| `scenes.json` checkpoints ↔ `scripts/lib/actions.ts` ↔ `fixtures/expected-results.json` | ids and totals must agree                           |
| `fixtures/expected-results.json` ↔ `fixtures/demo/expected-start.json`                  | hand-authored; never read back from app output      |
| annotation `region` ids ↔ captured `regions`                                            | must exist in `generated/capture-manifest.json`     |
| `generated/*` ↔ `review/*`                                                              | review is a frozen copy; refresh after every render |

## Story-specific constants (edit for a new video)

| Constant                           | Location                                                     | Effect if missed                                                 |
| ---------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `PROOF_SCENE`, `PROOF_MAX_SECONDS` | `scripts/timeline.ts`                                        | `video:proof` excerpts the wrong scene (hard-coded `S03` / 18 s) |
| `CAPTURE_ROLES`                    | `scripts/auth.ts`                                            | a required role is never signed in                               |
| `sceneActions` keys                | `scripts/lib/actions.ts`                                     | capture refuses with “No capture action is registered”           |
| `checkpoints`                      | `fixtures/recording-scenario.json` + `expected-results.json` | assertions fail closed                                           |

## Cleanup (same order in the runbook)

```sh
# stop the dev server FIRST, then remove its build dir
rm -rf apps/web/.next-video
RELAY_POSTGRES_PORT=55480 docker compose -p relay-video stop postgres
bun run video:auth:clear        # optional: drops local sessions only
```

Removing `.next-video` while `next dev` runs kills that server with exit 1 —
harmless, but it looks like a failure in task logs.

## Unrelated files in this checkout

`git status` may show untracked items from other lanes (root `final*.mp4`,
`.claude/`, the operator's `VIDEO-AGENT-PROMPT.md`). Leave them alone and never
`git add -A`. Note that `biome check .` fails on the untracked Markdown prompt file
(section formatting); move it aside or expect that one failure when running
`bun run verify` locally.
