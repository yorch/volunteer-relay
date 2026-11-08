import type { AuthorizationService, Result } from "@relay/contracts";
import type { LastOrganizationStore } from "@relay/db";
import { describe, expect, it, vi } from "vitest";
import { createLastOrganizationHints } from "./last-organization.ts";

// Database-free: controlled store and authorization adapters.
function denied(code: "NOT_FOUND" | "DEPENDENCY_UNAVAILABLE"): Result<never> {
  return {
    ok: false,
    error: {
      code,
      message: "synthetic",
      correlationId: "corr",
      retryable: code === "DEPENDENCY_UNAVAILABLE",
    },
  };
}

function fixture(input: {
  stored?: string | null;
  resolve?: AuthorizationService["resolve"];
  failRead?: boolean;
  failWrite?: boolean;
}) {
  const store = {
    read: vi.fn(async () => {
      if (input.failRead) throw new Error("unavailable");
      return input.stored ?? null;
    }),
    remember: vi.fn(async () => {
      if (input.failWrite) throw new Error("foreign key");
    }),
    forget: vi.fn(async () => {}),
  } satisfies LastOrganizationStore;
  const resolve = vi.fn(
    input.resolve ??
      (async () =>
        ({ ok: true, value: {} }) as Awaited<
          ReturnType<AuthorizationService["resolve"]>
        >),
  );
  const authorization = { resolve } as unknown as AuthorizationService;
  return {
    store,
    resolve,
    hints: createLastOrganizationHints({ store, authorization }),
  };
}

describe("last-used organization hints", () => {
  it("returns a hint only after live membership resolves for that user", async () => {
    const { hints, resolve } = fixture({ stored: "org-b" });
    expect(await hints.resolve("user-1")).toBe("org-b");
    expect(resolve).toHaveBeenCalledWith("user-1", "org-b", expect.any(String));
  });

  it("ignores and clears a hint whose membership is denied", async () => {
    const { hints, store } = fixture({
      stored: "org-foreign",
      resolve: async () => denied("NOT_FOUND"),
    });
    expect(await hints.resolve("user-1")).toBeNull();
    expect(store.forget).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-foreign",
    });
  });

  it("keeps the hint when authorization is temporarily unavailable", async () => {
    const { hints, store } = fixture({
      stored: "org-b",
      resolve: async () => denied("DEPENDENCY_UNAVAILABLE"),
    });
    expect(await hints.resolve("user-1")).toBeNull();
    expect(store.forget).not.toHaveBeenCalled();
  });

  it("never throws from a failing store", async () => {
    const reading = fixture({ failRead: true });
    expect(await reading.hints.resolve("user-1")).toBeNull();
    expect(reading.resolve).not.toHaveBeenCalled();

    const throwing = fixture({
      stored: "org-b",
      resolve: async () => {
        throw new Error("unavailable");
      },
    });
    expect(await throwing.hints.resolve("user-1")).toBeNull();

    const writing = fixture({ failWrite: true });
    await expect(
      writing.hints.remember("user-1", "org-b"),
    ).resolves.toBeUndefined();
  });

  it("does nothing without a stored hint", async () => {
    const { hints, resolve } = fixture({ stored: null });
    expect(await hints.resolve("user-1")).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });
});
