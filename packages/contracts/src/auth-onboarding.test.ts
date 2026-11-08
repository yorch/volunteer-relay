import { expect, it } from "vitest";
import {
  AUTH_PENDING_INVITATIONS_LIMIT,
  authOrganizationChoicesSchema,
  authPendingInvitationSchema,
  authPendingInvitationsSchema,
  authSignUpCommandSchema,
  authVerificationConfirmSchema,
  authVerificationRequestSchema,
} from "./index.ts";

it("freezes onboarding inputs without accepting authority or redirect overrides", () => {
  const signup = {
    name: "Synthetic Volunteer",
    email: "synthetic@example.invalid",
    password: "synthetic-pass",
  };
  expect(authSignUpCommandSchema.parse(signup)).toEqual(signup);
  for (const field of [
    "role",
    "organizationId",
    "emailVerified",
    "callbackURL",
  ]) {
    expect(
      authSignUpCommandSchema.safeParse({ ...signup, [field]: "owner" })
        .success,
    ).toBe(false);
  }
  expect(
    authVerificationRequestSchema.safeParse({ email: signup.email }).success,
  ).toBe(true);
  expect(
    authVerificationRequestSchema.safeParse({
      email: signup.email,
      callbackURL: "https://foreign.invalid",
    }).success,
  ).toBe(false);
  expect(
    authVerificationConfirmSchema.safeParse({ token: "synthetic-token" })
      .success,
  ).toBe(true);
  expect(authVerificationConfirmSchema.safeParse({ token: "" }).success).toBe(
    false,
  );
});
it("allows unknown selection and rejects inconsistent organization projections", () => {
  const option = {
    organizationId: "garden",
    name: "Synthetic Garden",
    slug: "garden",
    membershipId: "membership",
    role: "volunteer",
  };
  expect(
    authOrganizationChoicesSchema.safeParse({
      currentOrganizationId: null,
      options: [],
    }).success,
  ).toBe(true);
  expect(
    authOrganizationChoicesSchema.safeParse({
      currentOrganizationId: "garden",
      options: [option],
    }).success,
  ).toBe(true);
  expect(
    authOrganizationChoicesSchema.safeParse({
      currentOrganizationId: "foreign",
      options: [option],
    }).success,
  ).toBe(false);
  expect(
    authOrganizationChoicesSchema.safeParse({
      currentOrganizationId: null,
      options: [option, option],
    }).success,
  ).toBe(false);
});
it("freezes the pending-invitation list without authority-bearing fields", () => {
  const item = {
    invitationId: "invitation-a",
    organizationName: "Synthetic Garden",
    role: "volunteer",
    expiresAt: "2026-02-01T00:00:00.000Z",
  };
  expect(
    authPendingInvitationsSchema.parse({
      emailVerified: true,
      invitations: [item],
    }),
  ).toEqual({ emailVerified: true, invitations: [item] });
  expect(
    authPendingInvitationsSchema.safeParse({
      emailVerified: false,
      invitations: [],
    }).success,
  ).toBe(true);
  // Unverified callers never receive invitation rows.
  expect(
    authPendingInvitationsSchema.safeParse({
      emailVerified: false,
      invitations: [item],
    }).success,
  ).toBe(false);
  for (const field of [
    "organizationId",
    "email",
    "inviterId",
    "inviterEmail",
    "status",
  ])
    expect(
      authPendingInvitationSchema.safeParse({ ...item, [field]: "x" }).success,
    ).toBe(false);
  expect(
    authPendingInvitationsSchema.safeParse({
      emailVerified: true,
      invitations: [item],
      total: 1,
    }).success,
  ).toBe(false);
  expect(
    authPendingInvitationSchema.safeParse({ ...item, role: "admin" }).success,
  ).toBe(false);
  expect(
    authPendingInvitationSchema.safeParse({ ...item, expiresAt: "tomorrow" })
      .success,
  ).toBe(false);
  expect(
    authPendingInvitationsSchema.safeParse({
      emailVerified: true,
      invitations: [item, item],
    }).success,
  ).toBe(false);
  const many = Array.from(
    { length: AUTH_PENDING_INVITATIONS_LIMIT + 1 },
    (_, index) => ({ ...item, invitationId: `invitation-${index}` }),
  );
  expect(AUTH_PENDING_INVITATIONS_LIMIT).toBe(20);
  expect(
    authPendingInvitationsSchema.safeParse({
      emailVerified: true,
      invitations: many.slice(0, 20),
    }).success,
  ).toBe(true);
  expect(
    authPendingInvitationsSchema.safeParse({
      emailVerified: true,
      invitations: many,
    }).success,
  ).toBe(false);
});
