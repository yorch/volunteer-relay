# Improvement backlog

Creative and structural upgrades that are **not** in the current cut. Ordered by
impact per unit of work. Everything here is reversible and lives inside
`video/**` unless noted.

Current baseline for comparison: 157.30 s, product visible at **17.2 s**,
8 scenes, no music, captions 40 px, heading spotlights only.

## Tier 1 — cheap, no recapture

### B1. End card that converts

Show the live app (`volunteer-relay.brnby.com`) next to the repository URL, plus a
QR code and the MIT line. Today S08 shows only the repo. ~30 min, composition-only.

### B2. Quantify the duplicate beat

A 2 s composed card on the S05 beat: `2 messages → 1 visit → 0 double counting`.
It is the most judge-legible claim in the story and it is literally true of the
implementation (`duplicate-contribution` constraint). ~1 h.

### B3. Engineering-credibility triptych

4 s card after S07: `unknown stays unknown` · `pending never counts as approved` ·
`every number keeps its source`. Optionally 1.5 s of the History page. ~1 h.

### B4. Craft pass

- top/bottom gradient scrim + 1–2 % grain to unify graphics with footage;
- captions ~10 % smaller on the scrim;
- clamp punch-in origins to 0.38–0.62 (current 0.30/0.70 clips sidebar labels);
- one 1 s “act” break before S05. ~2 h, no recapture.

### B5. Workflow spine

Thin top rail with five steps (`Inbox · Review · Ledger · Needs · Report`),
lighting up as scenes advance. Communicates breadth instantly and survives
recaptures because it is composition-only. ~1.5 h.

## Tier 2 — story structure

### B6. Cold open

Reorder so the payoff lands first: ledger row + `0 → 120 min` counter (0–3 s),
then the buried-update story tightened to ~11 s, then the inbox. Product visible
at ~12 s instead of 17 s with no extra runtime. ~half day, no recapture (re-cut
existing footage plus re-time).

### B7. “Source → records” explainer animation (S03)

4 s motion graphic: `message → [activity] → [60 min][60 min]`, lines drawn to the
source quote, then cut to the real review pane as proof. This explains the core
innovation faster than reading UI. ~half day, Remotion only.

### B8. Composed ledger bracket for S04

Because DOM boxes drift, draw the bracket in composition space over a _cropped_
ledger shot (crop is static, so alignment holds). Replaces the need for inner
spotlights. ~2–3 h plus one S04 recapture.

### B9. 15 s vertical cutdown

Hook + duplicate beat + end card, burned-in captions, 1080×1920. For sharing and
submission galleries. ~2 h once B1/B2 exist.

## Tier 3 — sound and performance

### B10. Music bed

Licensed ambient track at −28 LUFS under speech, ducked during narration, plus
one subtle whoosh on the act break. Needs a licensed file and an entry in
`docs/asset-licenses.md`. ~1 h after the asset.

### B11. Voice A/B

Render the same script with a second stock voice and compare energy; keep one.
Costs one full narration run (~2.4 k characters). ~1–2 h.

### B12. Pace experiment (only if B6 shortens the opener)

Try `speed 1.16` (~150 wpm) once the opening is tighter; check that the technical
sentences still land. Requires full regeneration + re-time.

## Blocked, not backlog

- **Hosted footage** — needs dedicated recording accounts on the deployment and a
  hosted org matching the authored baseline. `video:prepare` fails closed if it
  does not.
- **Per-identity passwords / second volunteer / dedicated recording tenant** —
  domain seed changes owned by another lane (see `docs/feature-audit.md` gaps).
- **Inner-element spotlights** — needs scroll-free takes (B8 is the cheaper path).
- **Live provider validation** (OpenAI, Telegram, SMTP) — opt-in checks, never run
  here; they would change what the narration may claim.

## Explicitly rejected

- AI avatar / talking head, stock footage, animated fake product screens.
- Invented metrics (time saved, accuracy, adoption) — the honesty is an asset.
- Speeding narration past ~150 wpm to fit more content.
- A third overlay style; heading spotlight + callout + accent is the language.
- Recapturing for every UI PR — batch it at a freeze point, then update the two
  “footage commit” rows.
