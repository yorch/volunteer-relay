import { expect, it } from "vitest";
import { organizationSettingsSchema } from "./settings.ts";

const settings = {
  revision: 1,
  timezone: "UTC",
  automationPolicy: "review-all",
  policyVersion: "1",
  fallbackMembershipId: null,
  ackMinutes: 60,
  retentionDays: 365,
};
it.each(["__proto__", "constructor", "prototype"])(
  "rejects reserved routing key %s before record parsing can drop it",
  (key) => {
    const routing = JSON.parse(`{"${key}":["staff"]}`);
    expect(
      organizationSettingsSchema.safeParse({ ...settings, routing }).success,
    ).toBe(false);
  },
);
it("keeps real category recipients intact", () => {
  expect(
    organizationSettingsSchema.parse({
      ...settings,
      routing: { transport: ["staff"] },
    }).routing,
  ).toEqual({ transport: ["staff"] });
});
