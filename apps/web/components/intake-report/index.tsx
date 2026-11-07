"use client";
import type { Receipt, Result, WebSourceSubmission } from "@relay/contracts";
import { receiptSchema, webSourceSubmissionSchema } from "@relay/contracts";
import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Card, Feedback, Field, TextArea } from "../foundation";
import styles from "./intake.module.css";

export function TextIntake({
  submit,
}: {
  submit: (command: WebSourceSubmission) => Promise<Result<Receipt>>;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const command = useRef<WebSourceSubmission | null>(null);
  const locked = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  const wasReceived = useRef(false);
  useEffect(() => {
    if (receipt) {
      wasReceived.current = true;
      receiptRef.current?.focus();
    } else if (wasReceived.current) {
      formRef.current?.querySelector("textarea")?.focus();
      wasReceived.current = false;
    }
  }, [receipt]);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (locked.current) return;
    const candidate = command.current ?? {
      schemaVersion: 1,
      idempotencyKey: crypto.randomUUID(),
      text,
    };
    const parsed = webSourceSubmissionSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(
        "Write an update of 1–20,000 characters, including some non-space text.",
      );
      const field = event.currentTarget.elements.namedItem("update");
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    command.current = parsed.data;
    locked.current = true;
    setPending(true);
    setError("");
    try {
      const result = await submit(parsed.data);
      if (result.ok) setReceipt(receiptSchema.parse(result.value));
      else
        setError(
          result.error.code === "CONFLICT"
            ? "This update conflicts with an earlier attempt. Start a new draft before resubmitting."
            : "The preview could not receive your update. Your draft is still here; try again.",
        );
    } catch {
      setError(
        "The preview could not receive your update. Your draft is still here; try again.",
      );
    } finally {
      locked.current = false;
      setPending(false);
    }
  }
  if (receipt)
    return (
      <div className={styles.stack} ref={receiptRef} tabIndex={-1}>
        <Feedback title="Simulated receipt — no data saved">
          Your update was received by the preview only. It has not been
          submitted to an organization or added to approved contributions.
        </Feedback>
        <Card title="Your preview status">
          <Badge tone="warning">
            Received · awaiting processing (simulated)
          </Badge>
          <dl>
            <dt>Preview receipt</dt>
            <dd>{receipt.sourceId}</dd>
            <dt>Source revision</dt>
            <dd>{receipt.revision}</dd>
          </dl>
          <p>
            Real processing, review and status updates will appear here when the
            service is connected.
          </p>
          <Button
            onClick={() => {
              setReceipt(null);
              setText("");
              setError("");
              command.current = null;
            }}
          >
            Write another preview update
          </Button>
        </Card>
      </div>
    );
  return (
    <Card title="Tell us what happened">
      <form ref={formRef} onSubmit={send} aria-busy={pending} noValidate>
        <Field
          id="volunteer-update"
          label="Your update"
          hint="Describe what you did, any time you know, and anything the team needs to follow up. Leave uncertain details uncertain."
          error={error}
        >
          <TextArea
            id="volunteer-update"
            name="update"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              command.current = null;
              setError("");
            }}
            disabled={pending}
            aria-invalid={Boolean(error)}
            aria-describedby={`volunteer-update-hint${error ? " volunteer-update-error" : ""}`}
            placeholder="Share an update in your own words…"
          />
        </Field>
        <p className={styles.muted}>
          Text only for now. Please share only what the team needs to know.
        </p>
        {error && (
          <Feedback tone="danger" title="Preview update not received">
            {error}
          </Feedback>
        )}
        {pending && (
          <Feedback title="Sending preview…">
            Please wait. No data will be saved.
          </Feedback>
        )}
        <div className={styles.actions}>
          <Button type="submit" disabled={pending}>
            {pending
              ? "Sending preview…"
              : error
                ? "Try preview again"
                : "Send preview update"}
          </Button>
          <span>{text.length.toLocaleString("en-US")} / 20,000 characters</span>
        </div>
      </form>
    </Card>
  );
}
