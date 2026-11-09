import { describe, expect, it } from "vitest";
import {
  operatorAccountsSchema,
  operatorCreateOrganizationCommandSchema,
  operatorMemberRoleCommandSchema,
  operatorOrganizationListSchema,
  operatorOrganizationQuerySchema,
  parseOperatorAccounts,
} from "./index.ts";

const account = "user-1:owner@example.org";

describe("operator allowlist", () => {
  it("parses userId:email entries and lowercases the address", () => {
    expect(
      parseOperatorAccounts(
        " user-1:Owner@Example.ORG , user-2:b@example.org ",
      ),
    ).toEqual([
      { userId: "user-1", email: "owner@example.org" },
      { userId: "user-2", email: "b@example.org" },
    ]);
  });

  it("is empty when the variable is absent or blank", () => {
    expect(parseOperatorAccounts(undefined)).toEqual([]);
    expect(parseOperatorAccounts("   ")).toEqual([]);
  });

  it("refuses malformed, duplicated, reserved and oversized lists", () => {
    for (const value of [
      "owner@example.org",
      "user-1:",
      ":owner@example.org",
      "user 1:owner@example.org",
      "user-1:not-an-email",
      `${account},other:owner@example.org`,
      "user-1:owner@example.invalid",
      Array.from(
        { length: 21 },
        (_, i) => `user-${i}:person${i}@example.org`,
      ).join(","),
    ])
      expect(() => parseOperatorAccounts(value)).toThrow();
  });

  it("never widens a list past the entry cap", () => {
    const twenty = Array.from(
      { length: 20 },
      (_, i) => `user-${i}:person${i}@example.org`,
    ).join(",");
    expect(parseOperatorAccounts(twenty)).toHaveLength(20);
  });

  it("accepts a single well-formed entry", () => {
    expect(operatorAccountsSchema.parse(account)).toEqual([
      { userId: "user-1", email: "owner@example.org" },
    ]);
  });
});

describe("operator contracts", () => {
  it("restricts a role change to ownership and requires an expected role", () => {
    expect(
      operatorMemberRoleCommandSchema.safeParse({
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
      }).success,
    ).toBe(true);
    expect(
      operatorMemberRoleCommandSchema.safeParse({
        organizationId: "org-1",
        membershipId: "member-1",
        role: "volunteer",
        expectedRole: "coordinator",
      }).success,
    ).toBe(false);
    expect(
      operatorMemberRoleCommandSchema.safeParse({
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
      }).success,
    ).toBe(false);
    expect(
      operatorMemberRoleCommandSchema.safeParse({
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
        operator: true,
      }).success,
    ).toBe(false);
  });

  it("bounds the search text and rejects wildcards and control characters", () => {
    expect(
      operatorOrganizationQuerySchema.safeParse({ q: "tide" }).success,
    ).toBe(true);
    for (const q of ["t", "a".repeat(101), "50%", "a_b\u0000", "  "])
      expect(operatorOrganizationQuerySchema.safeParse({ q }).success).toBe(
        false,
      );
    expect(
      operatorOrganizationQuerySchema.safeParse({ q: "tide", status: "open" })
        .success,
    ).toBe(false);
    expect(
      operatorOrganizationQuerySchema.safeParse({ cursor: "a".repeat(1025) })
        .success,
    ).toBe(false);
  });

  it("accepts creation input only with a valid slug, timezone and owner email", () => {
    const valid = {
      name: "Example Organization",
      slug: "example-organization",
      timezone: "America/New_York",
      ownerEmail: "owner@example.org",
    };
    expect(
      operatorCreateOrganizationCommandSchema.safeParse(valid).success,
    ).toBe(true);
    for (const patch of [
      { slug: "Example" },
      { slug: "-example" },
      { timezone: "Mars/Olympus" },
      { ownerEmail: "owner" },
      { name: "" },
      { name: "line\nbreak" },
      { extra: "field" },
    ])
      expect(
        operatorCreateOrganizationCommandSchema.safeParse({
          ...valid,
          ...patch,
        }).success,
      ).toBe(false);
  });

  it("requires the list envelope to be complete and strict", () => {
    const list = {
      organizations: [
        {
          organizationId: "org-1",
          name: "Example",
          slug: "example",
          createdAt: "2026-01-01T00:00:00.000Z",
          members: {
            owner: 1,
            coordinator: 0,
            volunteer: 0,
            reportReader: 0,
            total: 1,
          },
          owners: [
            {
              membershipId: "member-1",
              name: "Synthetic Owner",
              maskedEmail: "o•••@example.org",
              joinedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          ownersTruncated: false,
          pendingInvitations: 0,
        },
      ],
      nextCursor: null,
    };
    expect(operatorOrganizationListSchema.safeParse(list).success).toBe(true);
    expect(
      operatorOrganizationListSchema.safeParse({
        ...list,
        organizations: [
          {
            ...list.organizations[0],
            owners: [
              {
                ...list.organizations[0]?.owners[0],
                email: "owner@example.org",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      operatorOrganizationListSchema.safeParse({
        ...list,
        nextCursor: undefined,
      }).success,
    ).toBe(false);
  });
});
