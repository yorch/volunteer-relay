"use client";
import type { ReviewQueueEntry } from "@relay/contracts";
import { reviewDecisionSchema } from "@relay/contracts";
import { useState } from "react";
import { Field, Select } from "../foundation";
import { ReviewInbox } from "./index";

export function ReviewPreview({
  entries,
  memberLabels,
}: {
  entries: readonly ReviewQueueEntry[];
  memberLabels: Readonly<Record<string, string>>;
}) {
  const [scenario, setScenario] = useState("success");
  return (
    <>
      <Field id="review-scenario" label="Preview response">
        <Select
          id="review-scenario"
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
        >
          <option value="success">Simulated success</option>
          <option value="conflict">Simulated revision conflict</option>
          <option value="error">Simulated unavailable service</option>
          <option value="empty">Empty inbox</option>
        </Select>
      </Field>
      <ReviewInbox
        key={scenario}
        entries={scenario === "empty" ? [] : entries}
        memberLabels={memberLabels}
        decide={async (input) => {
          const command = reviewDecisionSchema.parse(input);
          await new Promise((resolve) => setTimeout(resolve, 700));
          if (scenario === "conflict" || scenario === "error")
            return {
              ok: false,
              error: {
                code:
                  scenario === "conflict"
                    ? "CONFLICT"
                    : "DEPENDENCY_UNAVAILABLE",
                message: "Simulated failure",
                correlationId: "preview-review",
                retryable: scenario === "error",
              },
            };
          // This fixture adapter verifies the consumer uses the review aggregate, not the source revision.
          const entry = entries.find(
            (value) => value.proposal.runId === command.runId,
          );
          if (!entry || command.expectedRevision !== entry.revision)
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: "Wrong preview revision",
                correlationId: "preview-review",
                retryable: false,
              },
            };
          return { ok: true, value: { revision: entry.revision + 1 } };
        }}
      />
    </>
  );
}
