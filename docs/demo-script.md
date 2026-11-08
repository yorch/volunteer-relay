# Three-minute demo script

A run-of-show for presenting a deployed instance. Timings are for a three-minute slot and
assume the demo data from [demo guidance](demo.md) is seeded.

All data used here is synthetic. Say so early — it pre-empts the question and it is true.

## Before you start

- [ ] Sign in as `demo-owner@example.invalid` (the password is the documented public fixture)
- [ ] Confirm the workspace opens on **Tidepath Mutual Aid**, not "choose an organization"
- [ ] Have a photo ready to send — see [the image](#the-image) below
- [ ] Telegram is linked to this account: send `/orgs` and expect a list including Tidepath
- [ ] Two windows side by side: the app on `/workspace/inbox`, and Telegram

## 0:00 — 0:20 · The problem

> Volunteer work is coordinated in chat. Somebody says _I spent two hours sorting donations_ —
> and that sentence never becomes a record. The hours go unrecorded, and the need mentioned in
> the same message never reaches anyone who can act on it.

Show `/workspace/inbox`.

> This is the same chaos, collected in one place. The point is what happens to it.

## 0:20 — 1:10 · Live: a message arrives

Send a photo **with this caption** to the bot:

```
Sorted canned goods at the Riverside shelter this morning — two hours with Ana.
```

> That's a photo and a sentence. No form, no app to open.

Wait a few seconds (ingestion polls), then refresh `/workspace/inbox`.

> It's already in the inbox — with the photo attached as evidence.

Open the new update. The right-hand pane shows the proposed records.

> One message became separate records: an activity — the visit — and a contribution — my two
> hours. They're separate because one visit can have several volunteers, and each person's time
> is counted separately.

Point at the evidence block: the original text, quoted.

A photo **without** a caption does not extract: the model receives image bytes without
attachment identifiers, so the caption is what carries the text. Send them together.

## 1:10 — 1:40 · The honesty moment

Do not skip this. Point at the `unresolved` notes on the proposal, for example:

> Ana is named as a participant, but no membership ID is supplied.

> It doesn't know who Ana is, so it says so instead of guessing. Same for anything it wasn't
> told — an unknown duration stays unknown, not zero, not an estimate.

Optional second beat — send:

```
Helped out at the food bank for a while last week, not sure how long.
```

> It will record the visit and refuse to invent the hours. That's the difference between a log
> and a ledger.

## 1:40 — 2:20 · Approve, and watch the number move

Approve the activity and the contribution in the review pane.

> Nothing is recorded until I approve it. This is `review-all`: the AI proposes, a person
> decides.

Go to `/workspace/reports`.

> Approved minutes are the reporting ledger. That number only moves when a human approved the
> time — pending proposals don't count, and a delivery attempt isn't an acknowledgment.

## 2:20 — 2:50 · The other half: needs

Go to `/workspace/needs`.

> The same message can raise a need. Needs have urgency, an owner and an acknowledge-by time,
> and they can be acknowledged straight from chat — the loop closes where the work happens.

Optionally show `/workspace/members` (roles) or `/workspace/retention` (redaction recorded in a
signed ledger).

## 2:50 — 3:00 · Close

> One inbox for updates, a human approval before anything is recorded, and a ledger you can
> defend. The AI is doing extraction — not deciding what's true.

## The image

Any photo of objects works. Constraints, in order of importance:

- **No faces**, no house numbers, no plates, no screens showing real data
- Canned goods, boxes of supplies, seedlings, a laptop on a desk — objects, not people
- Under `ATTACHMENT_MAX_BYTES` (10 MB); the pipeline re-encodes to PNG and strips metadata

A verified public-domain option: the Openverse record for _"Food for Fines canned goods drive"_
(rawpixel, CC0 1.0, originally a Flickr public-domain upload) — canned goods on a table, no
faces, with a small "Food for Fines" banner in frame. Attribution is not required under CC0.
Check any replacement image yourself: a public-domain licence says nothing about whether faces
or identifiers appear in the frame.

## Things not to claim

- **Not production-hardened.** No rate limiting or HSTS at the edge yet.
- **Photos need a caption** — a photo alone will not extract.
- **Synthetic data.** Tidepath is seeded; the demo accounts are public fixtures.
- **Avoid demoing a failed extraction** unless you are making the honesty point: one sample
  phrasing fails evidence validation, and that is a known open item.

## If something goes wrong

| Symptom                               | Do this                                                                            |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| Message doesn't appear after ~15 s    | Refresh the inbox; ingestion polls on a loop                                       |
| Bot says the account is not connected | Re-link: Notifications → Telegram → **Create link instruction** (10-minute expiry) |
| Inbox is empty                        | Wrong organization — check `/account`                                              |
| Extraction errors                     | Fall back to a seeded update already in the inbox; they review identically         |

## Twenty-second version

> Volunteers already send updates in chat. Relay turns those into reviewed records of hours and
> needs, with the original message kept as evidence — so the numbers you report are ones a
> person approved.
