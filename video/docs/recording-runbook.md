# Recording runbook

Exact commands and expected results for the Volunteer Relay video. Everything
here uses synthetic demo data only.

Recording principle: hosted capture is the default target. This workspace could
not record hosted footage because no recording-account credentials were supplied,
so all footage in `video/generated/captures/` is labelled `local` and came from a
disposable rehearsal database. Never present local footage as the deployed
release.

## 0. One-time setup

```sh
bun install --frozen-lockfile
cp video/.env.example video/.env.local     # then fill values locally; never commit
bun run video:doctor
```

`video:doctor` is read-only. It prints `PASS`/`WARN`/`BLOCK` per subsystem and a
summary; a `BLOCK` line names a real blocker (for example missing credentials or
an unignored credential path). It never prints a secret, never downloads a
browser, and never starts a container.

Node 26.11.1 is enforced by the scripts. FFmpeg/ffprobe must be on `PATH`.

## 1. Hosted preparation (default)

Prerequisites you must supply outside chat, in `video/.env.local` or the runner's
secret store:

- `VIDEO_*_EMAIL` / `VIDEO_*_PASSWORD` for the coordinator, owner, volunteer and
  report-reader recording identities, dedicated to the synthetic recording
  organization.
- `VIDEO_BASE_URL=https://volunteer-relay.brnby.com`,
  `VIDEO_TARGET_MODE=hosted`,
  `VIDEO_ALLOWED_ORIGIN=https://volunteer-relay.brnby.com`.
- `VIDEO_ORGANIZATION_ID` / `VIDEO_SECONDARY_ORGANIZATION_ID`.

```sh
bun run video:provision     # verifies each identity resolves the right tenant; creates nothing hosted
bun run video:prepare       # verifies the authored baseline read-only; deletes nothing
bun run video:auth          # unrecorded sign-in for each capture role
```

`video:prepare` refuses to continue when observed totals differ from
`fixtures/expected-results.json`; it never resets hosted data. Seed or accept the
state through the operator flow, or rehearse locally instead.

The deployed build does not expose a commit or build id. Record the deployment
identifier manually if the operator has one; otherwise state that it is unknown.

## 2. Local rehearsal (this workspace used it)

Use a dedicated Compose project and a disposable database whose name ends with
`_video_recording`. The tooling refuses anything else.

```sh
RELAY_POSTGRES_PORT=55480 docker compose -p relay-video up -d postgres
docker exec relay-video-postgres-1 createdb -U relay relay_video_recording

# Export for the app and the scripts (see/video/.env.local for the video side):
export NODE_ENV=development APP_URL=http://127.0.0.1:3300
export DATABASE_URL=postgres://relay:relay@127.0.0.1:55480/relay_video_recording
export ATTACHMENT_ROOT=$PWD/.relay-local/video-attachments
export BETTER_AUTH_SECRET=$(grep '^BETTER_AUTH_SECRET=' video/.env.local | cut -d= -f2-)
export VIDEO_LOCAL_DATABASE_MARKER=relay-video-recording

node packages/db/src/migrate.ts
bun run video:provision      # creates/reuses the synthetic demo identities, stores missing passwords 0600
node apps/web/node_modules/next/dist/bin/next dev apps/web --hostname 127.0.0.1 --port 3300
bun run video:prepare        # in a second shell: seed + verify the baseline
bun run video:auth
```

Restart from a clean state only by recreating your own disposable database:

```sh
docker exec relay-video-postgres-1 psql -U relay -d postgres \
  -c "drop database relay_video_recording with (force)"
docker exec relay-video-postgres-1 createdb -U relay relay_video_recording
node packages/db/src/migrate.ts && bun run video:provision && bun run video:prepare && bun run video:auth
```

`bun run video:prepare -- --reset` prints this instruction instead of executing
it: routine preparation never destroys data.

## 3. Narration

Final narration needs ElevenLabs configuration: `ELEVENLABS_API_KEY`,
`ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` (`eleven_multilingual_v2` or another
model with `can_do_text_to_speech`), plus `--yes` to accept paid generation.

```sh
bun run video:voice -- --dry-run     # script/manifest sync, character estimate, cache plan
bun run video:voice -- --yes         # one request per missing scene, max two attempts
bun run video:voice -- --scene S04 --yes   # deliberate single-scene regeneration
bun run video:voice -- --audio-dir path/to/audio   # supplied audio alternative
bun run video:voice -- --scratch     # timing-only local voice, labelled as such
```

The cache key covers text, provider, model, voice, settings, pronunciations and
output format; only cache misses are requested, each completed scene is persisted
immediately (so a later failure never re-bills it), and `--force` is required to
regenerate everything. Supplied or scratch audio deletes any stale provider
alignment before it is used. Pronunciation overrides live in
`narration/pronunciations.json`.

Narration is currently **blocked** in this environment (no key). The proof render
used `--scratch`, so its audio is a labelled local timing voice, not the final
voice.

## 4. Capture

```sh
bun run video:capture                 # all product scenes, in order
bun run video:capture -- --scene S04  # one scene from its declared checkpoint
```

Each take: fresh 1920×1080 context, per-role storage state, readiness marker,
checkpoint assertion (`fixtures/expected-results.json`), scripted staff action,
post-action checkpoint assertion, hold to the scene minimum, then close. The WebM
is normalised to H.264 yuv420p 30 fps 1920×1080 and published with its own
manifest entry (scene, exact base URL, origin, markers) immediately; failed takes
delete their temporary recordings. Capturing from a different target while an
existing manifest is present is refused — remove `generated/captures/` and the
manifest first, never mix origins.

Scene order and checkpoints:

| Scene | Role        | Route                                     | Starts from | Establishes |
| ----- | ----------- | ----------------------------------------- | ----------- | ----------- |
| S02   | coordinator | `/workspace/inbox`                        | baseline    | —           |
| S03   | coordinator | `/workspace/inbox`                        | baseline    | —           |
| S04   | coordinator | `/workspace/inbox` → accept → ledger      | baseline    | after-s04   |
| S05   | coordinator | `/workspace/inbox` → reject duplicate     | after-s04   | after-s05   |
| S06   | owner       | `/workspace/needs` → assign → acknowledge | after-s05   | after-s06   |
| S07   | coordinator | `/workspace/reports`                      | after-s06   | —           |

A single-scene capture is only valid while the database still sits at that
scene's starting checkpoint. After S04/S05/S06 the state has moved. `--fresh`
discards the whole capture directory and manifest (all scenes) — it is not a
per-scene reset.

Keep the worker stopped during capture: escalation consumes an acknowledgement
deadline and the video never simulates elapsed time.

## 5. Timeline, preview, render

```sh
bun run video:timeline     # measured frame boundaries + captions + SRT
bun run video:preview      # Remotion Studio at 1920x1080
bun run video:proof        # 18 s excerpt of S03 → output/proof.mp4
bun run video:render -- --draft
bun run video:render       # only after final narration exists
bun run video:validate
```

Frame rules: 30 fps, integer boundaries, scene = `max(minSeconds, narration +
0.6s tail)` rounded up, capped per scene; the programme is rejected above 180 s.
Captions are stored per scene and rebased for the proof excerpt.

`video:render` (full, not `--draft`/`--proof`) refuses to start unless the audio on
disk is final (not scratch), matches the timeline's measured durations, every
narrated scene has captions, every product scene has a capture, and all captures
share one base URL. `final.mp4` is reserved for that validated full render;
`--proof`, `--draft` and `--scene` cannot write it. S03 carries an on-screen
"Authored demo proposal · no live model call" label.

Remotion uses an existing Playwright Chrome Headless Shell when one is cached
(`REMOTION_BROWSER_EXECUTABLE` overrides). Without one it downloads a browser on
first render, which needs network access.

## 6. After recording

- `bun run video:auth:clear` and remove `video/.auth/`.
- Rotate or disable the recording identities in the application.
- Keep `video/generated/` and `video/output/` out of git; they are ignored.
- Record actual loudness and dimensions from `video:validate`, not from the
  requested settings.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Missing VIDEO_*_PASSWORD`                                     | Supply credentials or run `video:provision` in local mode.                                                                                                                          |
| Sign-in page reloads in a loop, inputs detach while typing     | Two `next dev` processes share `apps/web/.next`. Start the rehearsal server with `RELAY_NEXT_DIST_DIR=.next-video` (ignored) so a concurrent e2e run or build cannot invalidate it. |
| `Refusing local preparation: database …`                       | The database name must end `_video_recording` and `VIDEO_LOCAL_DATABASE_MARKER=relay-video-recording`.                                                                              |
| `does not match the authored oracle`                           | The database moved past the authored state. Recreate your own disposable database, or accept the state through the operator flow on hosted.                                         |
| `narration needs Xs but the scene cap is Ys`                   | Shorten the narration or raise the cap deliberately; never speed the voice.                                                                                                         |
| `captured footage … shorter than the … scene`                  | Recapture with a longer hold; never loop an action.                                                                                                                                 |
| `The need's manage panel never exposed the acknowledge action` | Acknowledgment is only allowed for the current owner; S06 uses the owner session.                                                                                                   |
| Remotion `ETIMEDOUT` while downloading a browser               | Point `REMOTION_BROWSER_EXECUTABLE` at a local Chrome/Chromium binary.                                                                                                              |
| Sign-in rejected / redirect to another origin                  | The identity is not a member of the configured organization, or `VIDEO_ALLOWED_ORIGIN` differs from the target. Fix configuration; never weaken auth.                               |
