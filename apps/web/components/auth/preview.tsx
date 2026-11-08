"use client";

import type { AuthOrganizationOption, Result } from "@relay/contracts";
import { useState } from "react";
import { Field, FoundationRoot, PageHeading, Select } from "../foundation";
import {
  InvitationAcceptanceForm,
  OrganizationSwitcher,
  ResetConfirmForm,
  ResetRequestForm,
  SignInForm,
} from ".";
import styles from "./auth.module.css";

const options: readonly AuthOrganizationOption[] = [
  {
    organizationId: "synthetic-garden",
    name: "Synthetic Garden",
    slug: "synthetic-garden",
    membershipId: "member-garden",
    role: "volunteer",
  },
  {
    organizationId: "synthetic-library",
    name: "Synthetic Library",
    slug: "synthetic-library",
    membershipId: "member-library",
    role: "report-reader",
  },
];
export function AuthPreview() {
  const [mode, setMode] = useState("success");
  const [calls, setCalls] = useState(0);
  const [payloadSafe, setPayloadSafe] = useState(true);
  const [current, setCurrent] = useState<string | null>("synthetic-garden");
  async function simulate(
    command: object,
    keys: string[],
    identifiersMatch = true,
  ): Promise<Result<void>> {
    setCalls((count) => count + 1);
    setPayloadSafe(
      identifiersMatch &&
        Object.keys(command).sort().join() === [...keys].sort().join(),
    );
    // Synthetic delay lets browser checks inspect pending locks. No payload is retained.
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (mode === "throw") throw new Error("Synthetic transport failure");
    return mode === "error"
      ? {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Synthetic private transport detail",
            correlationId: "synthetic",
            retryable: false,
          },
        }
      : { ok: true, value: undefined };
  }
  return (
    <FoundationRoot>
      <main className={styles.preview}>
        <PageHeading
          title="Simulated authentication"
          description="Development preview — no data saved. No sessions, mail or real authentication."
        />
        <Field id="simulation" label="Simulated outcome">
          <Select
            id="simulation"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="success">Success</option>
            <option value="error">Safe error</option>
            <option value="throw">Transport failure</option>
          </Select>
        </Field>
        <p>
          Simulated calls: <span data-testid="calls">{calls}</span>. Payload
          keys: {payloadSafe ? "expected" : "unexpected"}.
        </p>
        <SignInForm
          onSignIn={(command) => simulate(command, ["email", "password"])}
        />
        <ResetRequestForm
          onRequestReset={(command) => simulate(command, ["email"])}
        />
        <ResetConfirmForm
          token="synthetic-reset-token"
          onConfirmReset={(command) =>
            simulate(
              command,
              ["token", "newPassword"],
              command.token === "synthetic-reset-token",
            )
          }
        />
        <InvitationAcceptanceForm
          invitationId="synthetic-invitation"
          onAcceptInvitation={(command) =>
            simulate(
              command,
              ["invitationId"],
              command.invitationId === "synthetic-invitation",
            )
          }
        />
        <OrganizationSwitcher
          currentOrganizationId={current}
          options={options}
          onSelectOrganization={async (command) => {
            const result = await simulate(
              command,
              ["organizationId"],
              options.some(
                (option) => option.organizationId === command.organizationId,
              ),
            );
            if (result.ok) setCurrent(command.organizationId);
            return result;
          }}
        />
        <OrganizationSwitcher
          currentOrganizationId={null}
          options={[]}
          onSelectOrganization={(command) =>
            simulate(command, ["organizationId"])
          }
        />
      </main>
    </FoundationRoot>
  );
}
