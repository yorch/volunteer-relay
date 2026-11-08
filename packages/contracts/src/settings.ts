import { z } from "zod";
import { automationPolicySchema } from "./policies.ts";

const membershipId = z.string().min(1);
export const organizationSettingsSchema = z
  .object({
    revision: z.number().int().positive(),
    timezone: z.string().refine((zone) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, "Unknown timezone"),
    automationPolicy: automationPolicySchema,
    policyVersion: z.string().min(1).max(100),
    routing: z.record(z.string(), z.array(membershipId).max(50)),
    fallbackMembershipId: membershipId.nullable(),
    ackMinutes: z.number().int().min(1).max(10080),
    retentionDays: z.number().int().min(1).max(3650),
  })
  .strict();
export type OrganizationSettings = z.infer<typeof organizationSettingsSchema>;
export const updateOrganizationSettingsSchema = organizationSettingsSchema
  .omit({ revision: true })
  .extend({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().min(1),
  })
  .strict();
export type UpdateOrganizationSettings = z.infer<
  typeof updateOrganizationSettingsSchema
>;
export interface ProductNotification {
  id: string;
  revision: number;
  type: "need-assigned" | "need-overdue";
  needId: string;
  title: string;
  appPath: string;
  createdAt: string;
  readAt: string | null;
}
