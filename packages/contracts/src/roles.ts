import { z } from "zod";

// The role vocabulary lives in its own module so contract modules that need it
// (operator.ts) do not have to import the barrel, which re-exports them and
// would create an initialization cycle.
export const roleSchema = z.enum([
  "owner",
  "coordinator",
  "volunteer",
  "report-reader",
]);
export type ContractRole = z.infer<typeof roleSchema>;
