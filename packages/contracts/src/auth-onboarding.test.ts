import { expect, it } from "vitest";
import {
  authOrganizationChoicesSchema,
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
