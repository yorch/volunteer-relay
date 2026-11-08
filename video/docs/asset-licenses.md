# Asset licences and attribution

Verified against official sources on 2026-11-08. Re-check before any commercial
use or when bumping a major version.

## Remotion (video composition, renderer, CLI)

- Installed: `remotion@4.0.541`, `@remotion/cli@4.0.541`.
- Licence: the **Remotion License**, source-available, not MIT. The package
  declares `"SEE LICENSE IN LICENSE.md"`.
- Free License eligibility (https://www.remotion.dev/docs/license/faq,
  https://www.remotion.dev/docs/terms): individuals (personal or commercial), an
  organization or team of **up to three people**, non-profits, and evaluation
  use. Larger for-profit organizations need a paid Company License, and
  automated rendering is governed by the applicable paid plan
  (https://www.remotion.dev/docs/license/pricing).
- Action required: the operator must confirm which tier applies to the entity
  publishing the video before rendering commercially. Do not assume the
  repository's MIT licence covers Remotion.
- `@remotion/compositor-darwin-arm64` ships prebuilt binaries under the same
  terms.

## Fonts

- `DM Sans` and `Manrope`, both SIL Open Font License 1.1, vendored in the app at
  `apps/web/app/fonts/*/OFL.txt`. The video reuses those families by name and
  does not copy or modify the font files.

## Application and fixtures

- Volunteer Relay application code: MIT (`LICENSE`).
- Demo dataset, narration text, screen content and the opening chat illustration:
  authored in this repository, synthetic, no third-party rights.
- Capture footage: recorded from the local rehearsal build with synthetic demo
  identities and data. It contains no real person, beneficiary or message.

## Tools invoked, not redistributed

- FFmpeg/ffprobe (host installation): check the build's licence before
  redistribution; the video only uses it to probe and transcode.
- Playwright Chromium / Chrome Headless Shell: used to capture and render, not
  redistributed.
- macOS `say` (scratch timing voice only): system component, not redistributed
  and not the final narration.

## Narration and music

- ElevenLabs narration, when generated, is subject to the ElevenLabs terms of the
  account that produced it. Keep the account tier and voice licence on file.
- No voice cloning is used; one stock voice and one settings set for the whole
  programme.
- Music bed: none by default. If one is added, record composer, source URL,
  licence (allowing monetised video use), attribution text and any content-ID
  registration here before rendering.

## Attribution required in the video

None for the current asset set beyond the on-screen synthetic-data and
AI-narration disclosure in S01 and S08. Add attribution here first if a licensed
music or footage asset is introduced.
