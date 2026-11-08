# Narration script

Editorial baseline from the video brief, tightened around features that exist in
this repository. `video/scenes.json` is the machine-readable source of truth; this
file is the readable draft and must stay word-for-word in sync (the voice
commands fail on drift).

Voice direction: clear, conversational, grounded, warm without sales hype.
Moderate pace, natural pauses, emphasis on "one visit" and "two volunteer-hours".
One voice and one settings set for the whole programme. No voice cloning.

Claim boundary: 40 volunteers and four hours a week are challenge context, not
measured results. No time savings, accuracy, adoption or beneficiary outcomes are
claimed. The recording uses the synthetic demo dataset only.

## S01 — The buried need

A volunteer spends an hour mentoring a child. Before she leaves, she learns the
family needs diapers tonight, so she posts a brief update. By morning it is
buried under dozens of messages. The hour may never be counted. The family may
still be waiting.

On screen: illustrative reenactment label. This is designed motion graphics, not
a real chat provider.

## S02 — Introduce the product

This is the problem behind challenge five: coordinators rebuild their week from
chats, texts and photos — forty volunteers, four hours a week, by hand. Volunteer Relay turns those updates into traceable
records, and needs someone owns. Here is the coordinator's inbox, with review
work waiting.

On screen: real capture of the coordinator inbox.

## S03 — One everyday update

Volunteers report in their own words. This update describes one shared garden
visit, two volunteers, and the time each of them gave. Relay proposes an activity
and two contributions, and keeps every proposed field tied to the original
message. Nothing is approved until staff decide.

On screen: the review pane. The proposal is a stored synthetic fixture in this
demo profile (deterministic staging); the review decision itself is a real
persisted action.

## S04 — Inspect and approve

One message holds a visit for two people. One shared hour means one visit and two
volunteer-hours, so approving it records two separate contributions of sixty
minutes each. Staff can inspect the evidence first, and anything missing or
unresolved stays visible instead of being guessed. Nothing is guessed.

On screen: accept the proposal, then the contribution ledger.

## S05 — Duplicate report

A later update describes the same visit. Counting every message would inflate the
totals, so Relay raises the possible duplicate for staff review. Rejecting it
leaves the approved ledger unchanged, and the decision stays attached to its
source.

On screen: the possible-duplicate item and its unresolved flag; totals before and
after are the same.

## S06 — Ownership and acknowledgment

An urgent need should never wait on a buried message. Staff assign an owner, set
an acknowledgment deadline, and later record the outcome. If acknowledgment
stalls, the worker escalates at the deadline. Delivery is not acknowledgment, and
the board shows what still needs attention. Acknowledgment is a person, not a
delivery receipt.

On screen: assign the urgent transport need, then acknowledge it. Escalation is
implemented in the worker and is narrated but not captured: no clock is changed
and no elapsed deadline is simulated.

## S07 — Report with evidence

At the end of the week the report comes from the same records the team used to do
its work. Approved hours, contributions, open needs and pending items are counted
consistently, and unknown time stays unknown rather than becoming zero. Every
decision is kept in an audit history with its source, so report and work share
one source.

On screen: the filtered weekly report.

## S08 — Close

Volunteer Relay. Every hour counted, every need connected. Built for nonprofit
teams, with fictional demo data and an open-source implementation. The repository
holds the code, the plan and the recording notes.

On screen: product name, tagline, repository URL, MIT license, and the
synthetic-data / AI-narration disclosure. The URL holds long enough to read.
