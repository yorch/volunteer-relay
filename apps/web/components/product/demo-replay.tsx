"use client";

import { type FormEvent, useEffect, useState } from "react";
import { request } from "../api-client";
import { Live } from "../card";
import { Button, Select } from "../foundation";
import styles from "./demo-replay.module.css";
import type { Mutate } from "./shared";

export const DEMO_REPLAY_ENDPOINT = "/api/product/demo-replay";

type SampleOption = {
  id: string;
  label: string;
  scenario: string;
  hasPhoto: boolean;
};
type Capability =
  | { enabled: false }
  | { enabled: true; samples: SampleOption[] };
type ReplayResult = {
  sampleId: string;
  sourceId: string;
  proposal: "review" | "accepted" | "rejected" | "queued";
};

function outcome(result: ReplayResult, label: string): string {
  switch (result.proposal) {
    case "review":
      return `Replayed "${label}". Its proposal is waiting in the review queue.`;
    case "accepted":
      return `Replayed "${label}". The organization policy recorded it automatically.`;
    case "rejected":
      return `Replayed "${label}". Its proposal was already decided.`;
    default:
      return `Replayed "${label}". It is queued for processing.`;
  }
}

/**
 * Demo-only control that injects one fixed synthetic sample through normal
 * intake. Renders nothing unless the server's capability probe reports demo
 * mode for this member; the server enforces the same gate on every replay.
 */
export function DemoReplay({ mutate }: { mutate: Mutate }) {
  const [capability, setCapability] = useState<Capability>({ enabled: false });
  const [sampleId, setSampleId] = useState("");
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let live = true;
    void request<Capability>(DEMO_REPLAY_ENDPOINT).then((result) => {
      if (!live || !result.ok) return;
      const value = result.value;
      if (!value?.enabled || !Array.isArray(value.samples)) return;
      setCapability(value);
      const first = value.samples[0]?.id ?? "";
      setSampleId((current) => current || first);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!capability.enabled || capability.samples.length === 0) return null;
  const selected = capability.samples.find((sample) => sample.id === sampleId);
  async function replay(event: FormEvent) {
    event.preventDefault();
    if (!selected || pending) return;
    setPending(true);
    setStatus(`Replaying "${selected.label}"…`);
    const label = selected.label;
    let message = "";
    const ok = await mutate(
      DEMO_REPLAY_ENDPOINT,
      { sampleId: selected.id },
      "Sample message replayed.",
      (value) => {
        message = outcome(value as ReplayResult, label);
      },
    );
    setStatus(ok ? message : "The sample was not replayed.");
    setPending(false);
  }
  return (
    <section className={styles.card}>
      <h2 id="demo-replay-heading">Replay a sample message</h2>
      <p className={styles.hint}>
        Demo mode only. Sends one fictional message through normal intake; no
        live chat, model or email is used.
      </p>
      <form
        className={styles.form}
        onSubmit={replay}
        aria-labelledby="demo-replay-heading"
      >
        <div className={styles.field}>
          <label htmlFor="demo-replay-sample">Sample message</label>
          <Select
            id="demo-replay-sample"
            name="sampleId"
            value={sampleId}
            disabled={pending}
            onChange={(event) => setSampleId(event.target.value)}
            aria-describedby="demo-replay-scenario"
          >
            {capability.samples.map((sample) => (
              <option key={sample.id} value={sample.id}>
                {sample.hasPhoto
                  ? `${sample.label} (with photo)`
                  : sample.label}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending || !selected}>
          {pending ? "Replaying…" : "Replay sample message"}
        </Button>
      </form>
      <p id="demo-replay-scenario" className={styles.hint}>
        {selected?.scenario ?? ""}
      </p>
      <Live kind="polite" className={styles.status}>
        {status}
      </Live>
    </section>
  );
}
