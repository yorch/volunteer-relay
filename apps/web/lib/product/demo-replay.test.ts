import type { TenantContext } from "@relay/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type DemoReplayDependencies,
  demoReplayEnabled,
  demoReplayIdentity,
  handleDemoReplay,
  parseDemoReplayBody,
} from "./demo-replay.ts";

const demoEnv = { DEMO_MODE: "true", NODE_ENV: "development" };
const coordinator: TenantContext = {
  organizationId: "org-a",
  actor: {
    kind: "user",
    userId: "user-a",
    membershipId: "member-a",
    role: "coordinator",
  },
  correlationId: "corr-a",
};

function deps(
  environment: Record<string, string | undefined>,
  grants: readonly string[] = ["source:submit", "review:write"],
) {
  const execute = vi.fn();
  const transaction = vi.fn();
  const require = vi.fn(async (context: TenantContext, permission: string) =>
    grants.includes(permission)
      ? { ok: true as const, value: undefined }
      : {
          ok: false as const,
          error: {
            code: "FORBIDDEN" as const,
            message: "denied",
            correlationId: context.correlationId,
            retryable: false,
          },
        },
  );
  const value = {
    db: { execute, transaction },
    authorization: { require },
    processing: { getSource: vi.fn() },
    store: {},
    environment,
  } as unknown as DemoReplayDependencies;
  return { value, execute, transaction, require };
}
const post = (body: unknown) =>
  new Request("http://localhost/api/product/demo-replay", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = () => new Request("http://localhost/api/product/demo-replay");

describe("demo replay gate", () => {
  it("is enabled only for validated demo mode outside production", () => {
    expect(demoReplayEnabled(demoEnv)).toBe(true);
    expect(demoReplayEnabled({ DEMO_MODE: "true", NODE_ENV: "test" })).toBe(
      true,
    );
    expect(demoReplayEnabled({ DEMO_MODE: "true" })).toBe(true);
    expect(demoReplayEnabled({})).toBe(false);
    expect(demoReplayEnabled({ DEMO_MODE: "false" })).toBe(false);
    expect(demoReplayEnabled({ DEMO_MODE: "TRUE" })).toBe(false);
    expect(demoReplayEnabled({ DEMO_MODE: "1" })).toBe(false);
    expect(
      demoReplayEnabled({
        DEMO_MODE: "true",
        NODE_ENV: "production",
        DATABASE_URL: "postgres://x@db/relay",
        BETTER_AUTH_SECRET: "x".repeat(40),
      }),
    ).toBe(false);
    // Any configuration the validator refuses fails closed.
    expect(
      demoReplayEnabled({ DEMO_MODE: "true", DATABASE_URL: "not a url" }),
    ).toBe(false);
  });
  it("answers NOT_FOUND to a replay and a disabled probe outside demo mode, before any lookup", async () => {
    for (const environment of [
      {},
      { DEMO_MODE: "false" },
      { DEMO_MODE: "true", NODE_ENV: "production" },
    ]) {
      const d = deps(environment);
      expect(
        await handleDemoReplay(
          coordinator,
          post({ sampleId: "spanish-update", idempotencyKey: "k" }),
          d.value,
        ),
      ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      expect(await handleDemoReplay(coordinator, get(), d.value)).toEqual({
        ok: true,
        value: { enabled: false },
      });
      expect(d.require).not.toHaveBeenCalled();
      expect(d.execute).not.toHaveBeenCalled();
      expect(d.transaction).not.toHaveBeenCalled();
    }
  });
  it("reports the capability only to members who may submit and review", async () => {
    const staff = await handleDemoReplay(
      coordinator,
      get(),
      deps(demoEnv).value,
    );
    expect(staff).toMatchObject({ ok: true, value: { enabled: true } });
    if (!staff.ok) throw new Error("Expected capability");
    const samples = (staff.value as { samples: Array<Record<string, unknown>> })
      .samples;
    expect(samples.length).toBeGreaterThan(0);
    // Picker data never carries the message text.
    for (const sample of samples) expect(sample).not.toHaveProperty("text");
    for (const grants of [["source:submit"], ["report:read"], []])
      expect(
        await handleDemoReplay(coordinator, get(), deps(demoEnv, grants).value),
      ).toEqual({ ok: true, value: { enabled: false } });
  });
  it("denies volunteers, report readers and system actors before reading the body", async () => {
    for (const grants of [["source:submit"], ["report:read"]]) {
      const d = deps(demoEnv, grants);
      expect(
        await handleDemoReplay(
          coordinator,
          post({ sampleId: "spanish-update", idempotencyKey: "k" }),
          d.value,
        ),
      ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(d.transaction).not.toHaveBeenCalled();
    }
    const system: TenantContext = {
      organizationId: "org-a",
      actor: { kind: "system", service: "worker" },
      correlationId: "corr-s",
    };
    const d = deps(demoEnv);
    expect(
      await handleDemoReplay(
        system,
        post({ sampleId: "spanish-update", idempotencyKey: "k" }),
        d.value,
      ),
    ).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(d.transaction).not.toHaveBeenCalled();
  });
  it("accepts only a catalog sample id and a key, never text, files or tenant fields", async () => {
    for (const body of [
      { sampleId: "custom", idempotencyKey: "k" },
      { sampleId: "spanish-update" },
      { sampleId: "spanish-update", idempotencyKey: "" },
      { sampleId: "spanish-update", idempotencyKey: "k", text: "injected" },
      {
        sampleId: "spanish-update",
        idempotencyKey: "k",
        organizationId: "org-b",
      },
      ["spanish-update"],
    ]) {
      const d = deps(demoEnv);
      expect(
        await handleDemoReplay(coordinator, post(body), d.value),
      ).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
      expect(d.transaction).not.toHaveBeenCalled();
    }
    expect(parseDemoReplayBody({ sampleId: "a", idempotencyKey: "b" })).toEqual(
      { sampleId: "a", idempotencyKey: "b" },
    );
    expect(
      parseDemoReplayBody({ sampleId: "a", idempotencyKey: "x".repeat(201) }),
    ).toBeNull();
  });
  it("derives a replay-prefixed identity from tenant, member, sample and key", () => {
    const one = demoReplayIdentity("org-a", "member-a", "spanish-update", "k");
    expect(one.sourceId).toMatch(/^replay:[a-f0-9]{64}$/);
    expect(one.idempotencyKey).toMatch(/^replay:[a-f0-9]{64}$/);
    expect(
      demoReplayIdentity("org-a", "member-a", "spanish-update", "k"),
    ).toEqual(one);
    for (const other of [
      demoReplayIdentity("org-b", "member-a", "spanish-update", "k"),
      demoReplayIdentity("org-a", "member-b", "spanish-update", "k"),
      demoReplayIdentity("org-a", "member-a", "urgent-need", "k"),
      demoReplayIdentity("org-a", "member-a", "spanish-update", "k2"),
    ])
      expect(other.sourceId).not.toBe(one.sourceId);
  });
});
