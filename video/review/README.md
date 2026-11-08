# Review media

Committed evidence for review, not build inputs. The pipeline writes real outputs
to the ignored `video/output/` and `video/generated/` directories; this folder is a
frozen copy so a reviewer can watch the result without running the toolchain.

## Provenance

| Field               | Value                                                                               |
| ------------------- | ----------------------------------------------------------------------------------- |
| Captured app commit | `ede1a71` (`main`, after PR #15 merged)                                             |
| Capture origin      | **local** rehearsal (`http://127.0.0.1:3300`) — not the hosted deployment           |
| Narration           | **scratch local voice** (`scratch-local-voice`), timing only — not final narration  |
| Captions            | phrase-level, derived proportionally from the scratch audio (no provider alignment) |
| Proof               | 18.00 s excerpt of S03, rendered by `bun run video:proof`                           |

The hosted origin (`https://volunteer-relay.brnby.com`) is healthy but no hosted
recording credentials exist here, so every clip is labelled `local`. Never present
this footage as the deployed release.

## Contents

| Path             | What it shows                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `proof.mp4`      | 1920×1080, 30 fps, H.264 yuv420p/bt709, AAC; 18.00 s; −16.9 LUFS, −5.6 dBTP                                             |
| `scenes/S02.mp4` | Coordinator inbox with 7 updates awaiting review (baseline)                                                             |
| `scenes/S03.mp4` | Original update beside proposed fields, each tied to its source                                                         |
| `scenes/S04.mp4` | Accept the shared-visit proposal, then the contribution ledger                                                          |
| `scenes/S05.mp4` | Possible duplicate rejected; approved totals unchanged                                                                  |
| `scenes/S06.mp4` | Assign the urgent transport need, then acknowledge it                                                                   |
| `scenes/S07.mp4` | Filtered weekly report with pending items kept separate                                                                 |
| `captions/`      | `captions.srt` (68 cues) and the per-scene JSON used by the composition                                                 |
| `manifests/`     | Capture manifest (per-scene origin/base URL/markers), timeline (162.30 s / 4 869 frames), render and validation reports |
| `stills/`        | Frames inspected at 1 s, 9 s and 16 s of the proof                                                                      |

Totals asserted during capture: baseline 180 approved minutes / 3 contributions /
7 in review / 10 sources; after S04 300 minutes / 5 contributions / 3 activities;
after S05 unchanged; after S06 the urgent need is acknowledged.

## Regenerating

```sh
bun run video:prepare     # local: disposable *_video_recording database
bun run video:auth
bun run video:capture -- --fresh
bun run video:voice -- --scratch      # or real narration with ElevenLabs configured
bun run video:timeline
bun run video:proof
bun run video:validate
```

Real narration will change the timeline (the final voice is slower than the
scratch voice), so regenerate `video:timeline`, the captions and the proof after
`bun run video:voice -- --yes`.
