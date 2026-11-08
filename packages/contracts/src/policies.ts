import { z } from "zod";
export const automationPolicySchema = z.enum([
  "review-all",
  "validated-auto-record",
]);
