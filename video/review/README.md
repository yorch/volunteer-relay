# Review media

Committed evidence for review, not build inputs. The pipeline writes real outputs
to the ignored `video/output/` and `video/generated/` directories; this folder is a
frozen copy so a reviewer can watch the result without running the toolchain.

## Provenance

| Field               | Value                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------- |
| Captured app commit | `c71d696` (`main`, after the review-media commit)                                         |
| Capture origin      | **local** rehearsal (`http://127.0.0.1:3300`) — not the hosted deployment                 |
| Narration           | **ElevenLabs** (`eleven_multilingual_v2`), one voice, 363-word draft, per-scene alignment |
| Captions            | phrase-level, derived from provider character alignment (`alignment`)                     |
| Proof               | 18.00 s excerpt of S03, rendered by `bun run video:proof`                                 |
| Mix                 | per-scene gain to −16 LUFS with a true-peak limiter                                       |

The hosted origin (`https://volunteer-relay.brnby.com`) is healthy but no hosted
recording credentials exist here, so every clip is labelled `local`. Never present
this footage as the deployed release.

## Contents

| Path             | What it shows                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `final.mp4`      | Full programme: 176.20 s, 1920×1080, 30 fps, H.264/AAC; −16.5 LUFS, −4.0 dBTP                                           |
| `proof.mp4`      | 1920×1080, 30 fps, H.264 yuv420p/bt709, AAC; 18.00 s; −16.4 LUFS, −4.2 dBTP                                             |
| `scenes/S02.mp4` | Coordinator inbox with 7 updates awaiting review (baseline)                                                             |
| `scenes/S03.mp4` | Original update beside proposed fields, each tied to its source                                                         |
| `scenes/S04.mp4` | Accept the shared-visit proposal, then the contribution ledger                                                          |
| `scenes/S05.mp4` | Possible duplicate rejected; approved totals unchanged                                                                  |
| `scenes/S06.mp4` | Assign the urgent transport need, then acknowledge it                                                                   |
| `scenes/S07.mp4` | Filtered weekly report with pending items kept separate                                                                 |
| `captions/`      | `captions.srt` (68 cues) and the per-scene JSON used by the composition                                                 |
| `manifests/`     | Capture manifest (per-scene origin/base URL/markers), timeline (176.20 s / 5 286 frames), render and validation reports |
| `stills/`        | Frames inspected at 1 s, 9 s and 16 s of the proof                                                                      |

Totals asserted during capture: baseline 180 approved minutes / 3 contributions /
7 in review / 10 sources; after S04 300 minutes / 5 contributions / 3 activities;
after S05 unchanged; after S06 the urgent need is acknowledged.

## Regenerating

```sh
bun run video:prepare     # local: disposable *_video_recording database
bun run video:auth
bun run video:capture -- --fresh
bun run video:voice -- --yes          # real narration (or --scratch for timing only)
bun run video:timeline
bun run video:proof
bun run video:validate
```

The render path normalises narration to −16 LUFS per scene and limits true peaks,
so neither the proof nor the final render needs manual gain staging. The final
`bun run video:render` is not run automatically; the programme is 176.20 s, under
the 180 s limit.
