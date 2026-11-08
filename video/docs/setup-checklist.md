# Setup checklist

Status as observed in this workspace on 2026-11-08. `configured` means the value
exists; `verified` means a sign-in or read-only probe succeeded; `blocked` means
the missing input is a real prerequisite.

## Organizations

| Requested                                                                       | Actual in this workspace                                                                                                             | Status                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `Tidepath Family Alliance — Recording` (`tidepath-recording`, America/New_York) | Shipped synthetic tenant `Tidepath Mutual Aid`, id `tidepath`, America/New_York                                                      | configured (local) — display name differs; renaming needs an application change, not a video change |
| `Mangrove Community Support — Isolation Demo` (`mangrove-isolation-demo`)       | Shipped second tenant `Harbor Neighbour Network`, id `harbor`, Europe/London                                                         | configured (local) — used for the boundary check only; no footage                                   |
| Recording-purpose marker / run id                                               | `fixtures/recording-scenario.json` `dataProfileMarker` + `VIDEO_SCENARIO_RUN_ID`; the demo profile writes `demo-product:v1:manifest` | configured                                                                                          |

Ids are the application's literal ids, not UUIDs.

## Identities

| Requested                 | Identity used                                       | Required permissions                            | Status                                                                                                                                         |
| ------------------------- | --------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Riley Demo Operator       | n/a                                                 | provisioning only                               | blocked — no operator tooling/credentials; `video:provision` verifies instead of creating hosted accounts                                      |
| Owen Carter               | `demo-coordinator@example.invalid` (`VIDEO_OWEN_*`) | review, approve, assign, reports                | verified (local)                                                                                                                               |
| Marisol Vega              | `demo-owner@example.invalid` (`VIDEO_MARISOL_*`)    | acknowledge needs, staff actions                | verified (local)                                                                                                                               |
| Sofia Martinez            | `demo-volunteer@example.invalid` (`VIDEO_SOFIA_*`)  | submit and read own updates                     | verified (local)                                                                                                                               |
| Ana Brooks                | none                                                | second volunteer for the later duplicate report | blocked — the demo profile authors the later update as the same volunteer; a second volunteer needs a seed change                              |
| Denise Board Reader       | `demo-reader@example.invalid` (`VIDEO_BOARD_*`)     | aggregate reports only                          | verified (local)                                                                                                                               |
| Casey Isolation Volunteer | `demo-multi@example.invalid` (`VIDEO_CASEY_*`)      | second tenant only                              | verified (local) as second-tenant report-reader; the profile has no per-tenant volunteer, so this is a different boundary shape than requested |

Passwords are the synthetic profile's intentionally public demo password, written
to `video/.env.local` (0600, ignored). They are never printed by the tooling,
never committed, and are not suitable for the hosted deployment.

## Services

| Setup                                            | Status                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Deployed app `https://volunteer-relay.brnby.com` | healthy at probe time (`/api/health`, `/api/ready` → 200, runtime 26.11.1); commit/build id not exposed → **unknown release** |
| Hosted recording credentials                     | **blocked** — none supplied in this environment                                                                               |
| AI extraction (server-side OpenAI)               | configured in code, **not verified**; no live key here, and the demo proposals are authored fixtures                          |
| Narration (ElevenLabs)                           | **blocked** — no API key/voice; a labelled local scratch voice was used for timing only                                       |
| Telegram                                         | not required for the core video; adapter exists, replay transport in the demo, no live check                                  |
| Email delivery                                   | controlled local Mailpit/SMTP only; no real recipients were contacted                                                         |
| Rendering (Remotion, Chromium, FFmpeg, ffprobe)  | ready; Remotion uses the cached Playwright Chrome Headless Shell via `REMOTION_BROWSER_EXECUTABLE`                            |
| Music bed                                        | none (narration only)                                                                                                         |

## Environment variables

Names only; see `video/.env.example`. `video/.env.local` is git-ignored and was
verified with `git check-ignore`.

`VIDEO_BASE_URL`, `VIDEO_TARGET_MODE`, `VIDEO_ALLOWED_ORIGIN`,
`VIDEO_ORGANIZATION_ID`, `VIDEO_SECONDARY_ORGANIZATION_ID`,
`VIDEO_SCENARIO_RUN_ID`, `VIDEO_OPERATOR_EMAIL`, `VIDEO_OPERATOR_PASSWORD`,
`VIDEO_OWEN_EMAIL`, `VIDEO_OWEN_PASSWORD`, `VIDEO_MARISOL_EMAIL`,
`VIDEO_MARISOL_PASSWORD`, `VIDEO_SOFIA_EMAIL`, `VIDEO_SOFIA_PASSWORD`,
`VIDEO_ANA_EMAIL`, `VIDEO_ANA_PASSWORD`, `VIDEO_BOARD_EMAIL`,
`VIDEO_BOARD_PASSWORD`, `VIDEO_CASEY_EMAIL`, `VIDEO_CASEY_PASSWORD`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`,
`VIDEO_LOCAL_DATABASE_MARKER`, optional `VIDEO_MUSIC_FILE`,
`REMOTION_BROWSER_EXECUTABLE`.

## Provisioning order used

1. Verify ignore rules (`git check-ignore video/.env.local`, `.auth/`,
   `generated/`, `output/`).
2. Create the disposable local database and export `DATABASE_URL`,
   `ATTACHMENT_ROOT`, `BETTER_AUTH_SECRET`, `APP_URL`, `VIDEO_LOCAL_DATABASE_MARKER`.
3. `node packages/db/src/migrate.ts`.
4. `bun run video:provision` → local writes require the same disposable-database
   guard as preparation; blank placeholders in `video/.env.local` are filled in
   place (existing values and emails are preserved), each role is verified against
   its tenant, the second-tenant session is verified, and the command exits
   non-zero if any role stays unverified.
5. `bun run video:prepare` → seed + authored baseline verified.
6. `bun run video:auth` → per-role storage state.
7. `bun run video:capture` → footage with checkpoint assertions.
