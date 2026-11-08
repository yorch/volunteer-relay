/**
 * Independently authored oracle for the demo replay catalog. Each entry was
 * written by hand from what the synthetic message says, not captured from
 * extraction output. `localDate: "receipt-day"` means the local calendar day
 * of receipt in the organization timezone ("today" in the message); `null`
 * means the message does not state a date, which must stay unknown.
 */

type ExpectedItem =
  | {
      kind: "activity";
      activityKind: "visit" | "supplies";
      localDate: "receipt-day" | null;
      beneficiaryReference: string | null;
    }
  | {
      kind: "contribution";
      /** The replaying member is the author; null minutes means unknown. */
      durationMinutes: number | null;
      authorIsContributor: true;
    }
  | {
      kind: "need";
      category: "food" | "supplies" | "general";
      urgency: "urgent" | "routine";
      provisional: boolean;
    }
  | { kind: "correction"; durationMinutes: number; targetId: null };

export interface DemoReplayExpectation {
  readonly items: readonly ExpectedItem[];
  /** Fields the proposal must leave for staff, in any order. */
  readonly unresolvedFields: readonly string[];
  readonly attachments: number;
}

export const demoReplayExpected: Readonly<
  Record<string, DemoReplayExpectation>
> = {
  "shared-visit-en": {
    items: [
      {
        kind: "activity",
        activityKind: "visit",
        localDate: "receipt-day",
        beneficiaryReference: "C-14",
      },
      { kind: "contribution", durationMinutes: 60, authorIsContributor: true },
    ],
    // Teodoro is named but not identified as a member.
    unresolvedFields: ["additionalParticipants"],
    attachments: 0,
  },
  "spanish-update": {
    items: [
      {
        kind: "need",
        category: "food",
        urgency: "routine",
        provisional: false,
      },
    ],
    unresolvedFields: [],
    attachments: 0,
  },
  "unknown-duration": {
    items: [
      {
        kind: "activity",
        activityKind: "visit",
        localDate: "receipt-day",
        beneficiaryReference: "A-09",
      },
      {
        kind: "contribution",
        durationMinutes: null,
        authorIsContributor: true,
      },
    ],
    unresolvedFields: ["durationMinutes"],
    attachments: 0,
  },
  "duplicate-visit": {
    items: [
      {
        kind: "activity",
        activityKind: "visit",
        localDate: "receipt-day",
        beneficiaryReference: "C-14",
      },
      { kind: "contribution", durationMinutes: 60, authorIsContributor: true },
    ],
    unresolvedFields: ["additionalParticipants", "duplicateCandidate"],
    attachments: 0,
  },
  "correction-90": {
    items: [{ kind: "correction", durationMinutes: 90, targetId: null }],
    unresolvedFields: ["targetId"],
    attachments: 0,
  },
  "urgent-need": {
    items: [
      { kind: "need", category: "food", urgency: "urgent", provisional: true },
    ],
    unresolvedFields: ["needFacts"],
    attachments: 0,
  },
  "supplies-photo": {
    items: [
      {
        kind: "activity",
        activityKind: "supplies",
        localDate: "receipt-day",
        beneficiaryReference: null,
      },
      {
        kind: "contribution",
        durationMinutes: null,
        authorIsContributor: true,
      },
    ],
    // A photo never supplies hours.
    unresolvedFields: ["durationMinutes"],
    attachments: 1,
  },
  "packing-shift": {
    items: [
      {
        kind: "activity",
        activityKind: "supplies",
        localDate: null,
        beneficiaryReference: null,
      },
      { kind: "contribution", durationMinutes: 90, authorIsContributor: true },
    ],
    unresolvedFields: ["localDate"],
    attachments: 0,
  },
};
