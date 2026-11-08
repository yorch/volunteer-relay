import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Recording scenario and independently authored expected results.
 *
 * The numbers in `fixtures/expected-results.json` are authored from the manual
 * demo oracle (fixtures/demo/expected-start.json) and the demo fixture
 * definitions - never copied from application output or a capture run.
 */

export const identitySchema = z
  .object({
    /** Product role the identity holds in the recording organization. */
    role: z.enum([
      "owner",
      "coordinator",
      "volunteer",
      "report-reader",
      "multi-organization",
      "isolation-volunteer",
    ]),
    displayName: z.string().min(1),
    email: z.string().email(),
    envEmail: z.string().regex(/^VIDEO_[A-Z0-9_]+$/),
    envPassword: z.string().regex(/^VIDEO_[A-Z0-9_]+$/),
    organization: z.enum(["primary", "secondary"]),
  })
  .strict();

export const recordingScenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    scenarioId: z.string().min(1),
    /** Marker already written by the demo profile, used to detect a seed. */
    dataProfileMarker: z.string().min(1),
    oracleFile: z.string().min(1),
    /** Inclusive day window the demo profile is authored for. */
    dateWindow: z
      .object({
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict(),
    primaryOrganization: z
      .object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        timezone: z.string().min(1),
        purpose: z.string().min(1),
      })
      .strict(),
    secondaryOrganization: z
      .object({
        id: z.string().min(1),
        displayName: z.string().min(1),
        timezone: z.string().min(1),
        purpose: z.string().min(1),
      })
      .strict(),
    identities: z.array(identitySchema).min(1),
    checkpoints: z
      .array(
        z
          .object({
            id: z.string().min(1),
            label: z.string().min(1),
            establishedBy: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const totalsSchema = z
  .object({
    sources: z.number().int().nonnegative(),
    reviewQueue: z.number().int().nonnegative(),
    approvedMinutes: z.number().int().nonnegative(),
    approvedContributions: z.number().int().nonnegative(),
    activitiesWithApprovedContributions: z.number().int().nonnegative(),
    pendingContributions: z.number().int().nonnegative(),
    pendingUnknownDuration: z.number().int().nonnegative(),
    openNeeds: z.number().int().nonnegative(),
    resolvedNeeds: z.number().int().nonnegative(),
  })
  .strict();

export const expectedResultsSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorship: z.string().min(1),
    baseline: totalsSchema,
    checkpoints: z.record(z.string(), totalsSchema.partial()),
  })
  .strict();

export type RecordingScenario = z.infer<typeof recordingScenarioSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type ObservedTotals = z.infer<typeof totalsSchema>;
export type ExpectedResults = z.infer<typeof expectedResultsSchema>;

export function loadScenario(path: string): RecordingScenario {
  const result = recordingScenarioSchema.safeParse(readJson(path));
  if (!result.success)
    throw new Error(`Invalid recording scenario: ${result.error.message}`);
  return result.data;
}

export function loadExpectedResults(path: string): ExpectedResults {
  const result = expectedResultsSchema.safeParse(readJson(path));
  if (!result.success)
    throw new Error(`Invalid expected results: ${result.error.message}`);
  return result.data;
}

function readJson(path: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${(error as Error).message}`);
  }
  return parsed;
}

export interface CheckpointComparison {
  ok: boolean;
  mismatches: Array<{ field: string; expected: number; observed: number }>;
}

/** Compare observed application totals with the authored checkpoint. */
export function compareTotals(
  expected: Readonly<Record<string, number | undefined>>,
  observed: ObservedTotals,
): CheckpointComparison {
  const mismatches: CheckpointComparison["mismatches"] = [];
  for (const [field, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    const seen = observed[field as keyof ObservedTotals];
    if (seen !== value)
      mismatches.push({ field, expected: value, observed: seen });
  }
  return { ok: mismatches.length === 0, mismatches };
}

export interface EffectiveOrganizations {
  primaryId: string;
  secondaryId: string;
}

/**
 * Configuration wins over the committed scenario: a dedicated recording tenant
 * supplied through VIDEO_ORGANIZATION_ID is what authentication and assertions
 * must use. The scenario remains the documented default.
 */
export function resolveOrganizations(
  env: Record<string, string | undefined>,
  scenario: RecordingScenario,
): EffectiveOrganizations {
  return {
    primaryId:
      env.VIDEO_ORGANIZATION_ID?.trim() || scenario.primaryOrganization.id,
    secondaryId:
      env.VIDEO_SECONDARY_ORGANIZATION_ID?.trim() ||
      scenario.secondaryOrganization.id,
  };
}

export function organizationIdFor(
  identity: Identity,
  organizations: EffectiveOrganizations,
): string {
  return identity.organization === "primary"
    ? organizations.primaryId
    : organizations.secondaryId;
}

/** Only the recording identities that a capture role maps onto. */
export function identityForRole(
  scenario: RecordingScenario,
  role:
    | "coordinator"
    | "volunteer"
    | "owner"
    | "report-reader"
    | "multi-organization",
): Identity {
  const identity = scenario.identities.find((entry) => entry.role === role);
  if (!identity)
    throw new Error(
      `The recording scenario has no ${role} identity. Add one to fixtures/recording-scenario.json.`,
    );
  return identity;
}
