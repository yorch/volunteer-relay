"use client";
import { receiptSchema, webSourceSubmissionSchema } from "@relay/contracts";
import { useRef, useState } from "react";
import { Field, Select } from "../foundation";
import { TextIntake } from "./index";

export function IntakePreview() {
  const [scenario, setScenario] = useState("success");
  const firstAttempt = useRef<{ key: string; text: string } | null>(null);
  return (
    <>
      <Field id="intake-scenario" label="Preview response">
        <Select
          id="intake-scenario"
          value={scenario}
          onChange={(event) => {
            firstAttempt.current = null;
            setScenario(event.target.value);
          }}
        >
          <option value="success">Simulated success</option>
          <option value="retry">Simulated transient error then retry</option>
          <option value="error">Simulated unavailable service</option>
        </Select>
      </Field>
      <TextIntake
        key={scenario}
        submit={async (command) => {
          webSourceSubmissionSchema.parse(command);
          // Bounded, local delay demonstrates pending feedback. No request is sent.
          await new Promise((resolve) => setTimeout(resolve, 700));
          const first = scenario === "retry" && firstAttempt.current === null;
          const repeated = firstAttempt.current;
          if (first)
            firstAttempt.current = {
              key: command.idempotencyKey,
              text: command.text,
            };
          if (scenario === "error" || first)
            return {
              ok: false,
              error: {
                code: "DEPENDENCY_UNAVAILABLE",
                message: "Preview unavailable",
                correlationId: "preview-intake-error",
                retryable: true,
              },
            };
          if (
            scenario === "retry" &&
            repeated &&
            (repeated.key !== command.idempotencyKey ||
              repeated.text !== command.text)
          )
            return {
              ok: false,
              error: {
                code: "CONFLICT",
                message: "Retry identity changed",
                correlationId: "preview-retry",
                retryable: false,
              },
            };
          return {
            ok: true,
            value: receiptSchema.parse({
              sourceId: "simulated-text-receipt",
              revision: 1,
              status: "received",
              correlationId: "preview-intake",
            }),
          };
        }}
      />
    </>
  );
}
