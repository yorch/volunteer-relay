import { describe, expect, it } from "vitest";
import { createOperatorDirectory } from "./accounts.ts";

const configured =
  "user-1:owner@example.org,user-2:second@example.org,user-3:third@example.org";

describe("createOperatorDirectory", () => {
  it("is disabled when nothing is configured", () => {
    expect(createOperatorDirectory(undefined).enabled).toBe(false);
    expect(createOperatorDirectory("").enabled).toBe(false);
    expect(
      createOperatorDirectory(undefined).identify({
        userId: "user-1",
        email: "owner@example.org",
        emailVerified: true,
      }),
    ).toBeNull();
  });

  it("requires the immutable user id and its own address to match", () => {
    const directory = createOperatorDirectory(configured);
    expect(
      directory.identify({
        userId: "user-1",
        email: "owner@example.org",
        emailVerified: true,
      }),
    ).toEqual({ userId: "user-1" });
    // Same address, different account: the pre-registration path.
    expect(
      directory.identify({
        userId: "user-9",
        email: "owner@example.org",
        emailVerified: true,
      }),
    ).toBeNull();
    // Configured id but another address on that account.
    expect(
      directory.identify({
        userId: "user-1",
        email: "other@example.org",
        emailVerified: true,
      }),
    ).toBeNull();
    // Substring and prefix lookalikes never match.
    for (const userId of ["user", "user-10", "user-1-", "USER-1"])
      expect(
        directory.identify({
          userId,
          email: "owner@example.org",
          emailVerified: true,
        }),
      ).toBeNull();
  });

  it("refuses an unverified session even with matching values", () => {
    const directory = createOperatorDirectory(configured);
    expect(
      directory.identify({
        userId: "user-1",
        email: "owner@example.org",
        emailVerified: false,
      }),
    ).toBeNull();
  });

  it("compares addresses case-insensitively, as stored by sign-up", () => {
    const directory = createOperatorDirectory(configured);
    expect(
      directory.identify({
        userId: "user-1",
        email: " Owner@Example.ORG ",
        emailVerified: true,
      }),
    ).toEqual({ userId: "user-1" });
  });

  it("refuses a malformed allowlist instead of granting nothing quietly", () => {
    expect(() => createOperatorDirectory("owner@example.org")).toThrow();
  });
});
