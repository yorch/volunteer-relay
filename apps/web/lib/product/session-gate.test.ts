import { describe, expect, it } from "vitest";
import { productSessionUser } from "./session-gate.ts";

describe("productSessionUser", () => {
  it("treats a missing session or user id as unauthenticated", () => {
    for (const session of [
      undefined,
      null,
      {},
      { user: null },
      { user: { id: "" } },
      { user: { emailVerified: true } },
    ])
      expect(productSessionUser(session)).toEqual({
        ok: false,
        code: "UNAUTHENTICATED",
      });
  });

  it("refuses tenant access for any email that is not verified true", () => {
    for (const emailVerified of [false, null, undefined])
      expect(
        productSessionUser({ user: { id: "user-synthetic", emailVerified } }),
      ).toEqual({ ok: false, code: "FORBIDDEN" });
  });

  it("passes the verified session's own user id", () => {
    expect(
      productSessionUser({
        user: { id: "user-synthetic", emailVerified: true },
      }),
    ).toEqual({ ok: true, userId: "user-synthetic" });
  });
});
