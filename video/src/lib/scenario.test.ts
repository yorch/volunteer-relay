import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseEnvFile, paths } from "./env.ts";
import {
  compareTotals,
  identityForRole,
  loadExpectedResults,
  loadScenario,
  type ObservedTotals,
} from "./scenario.ts";
import {
  assertOriginAllowed,
  isLoopbackHost,
  resolveTarget,
} from "./target.ts";

const scenario = loadScenario(paths.scenario);
const expected = loadExpectedResults(paths.expectedResults);

describe("recording scenario", () => {
  it("maps every capture role onto a dedicated identity", () => {
    for (const role of [
      "coordinator",
      "volunteer",
      "owner",
      "report-reader",
    ] as const)
      expect(identityForRole(scenario, role).email).toMatch(
        /@example\.invalid$/,
      );
  });

  it("keeps the secondary organization separate", () => {
    expect(scenario.secondaryOrganization.id).not.toBe(
      scenario.primaryOrganization.id,
    );
  });

  it("declares the demo profile window as fixed dates", () => {
    expect(scenario.dateWindow.from).toBe("2026-11-02");
    expect(scenario.dateWindow.to).toBe("2026-11-08");
  });
});

describe("authored oracle", () => {
  it("keeps the shared-visit and duplicate checkpoints consistent", () => {
    expect(expected.baseline.approvedMinutes).toBe(180);
    expect(expected.checkpoints["after-s04"]?.approvedMinutes).toBe(300);
    expect(expected.checkpoints["after-s04"]?.approvedContributions).toBe(5);
    expect(
      expected.checkpoints["after-s04"]?.activitiesWithApprovedContributions,
    ).toBe(3);
    expect(expected.checkpoints["after-s05"]?.approvedMinutes).toBe(
      expected.checkpoints["after-s04"]?.approvedMinutes,
    );
    expect(expected.checkpoints["after-s05"]?.approvedContributions).toBe(
      expected.checkpoints["after-s04"]?.approvedContributions,
    );
  });

  it("keeps unknown duration pending and open needs stable", () => {
    for (const totals of [
      expected.baseline,
      ...Object.values(expected.checkpoints),
    ]) {
      expect(totals.pendingUnknownDuration).toBe(1);
      expect(totals.openNeeds).toBe(4);
      expect(totals.resolvedNeeds).toBe(1);
    }
  });
});

describe("checkpoint comparison", () => {
  const observed: ObservedTotals = {
    ...expected.baseline,
  };

  it("passes when totals match", () => {
    expect(compareTotals(expected.baseline, observed).ok).toBe(true);
  });

  it("reports each mismatch by field", () => {
    const comparison = compareTotals(
      expected.checkpoints["after-s04"] ?? {},
      observed,
    );
    expect(comparison.ok).toBe(false);
    expect(comparison.mismatches.map((entry) => entry.field).sort()).toEqual([
      "activitiesWithApprovedContributions",
      "approvedContributions",
      "approvedMinutes",
      "reviewQueue",
    ]);
  });

  it("ignores fields the checkpoint does not assert", () => {
    expect(compareTotals({ approvedMinutes: 180 }, observed).ok).toBe(true);
  });
});

describe("capture target guard", () => {
  it("accepts the documented hosted origin", () => {
    const target = resolveTarget({
      VIDEO_TARGET_MODE: "hosted",
      VIDEO_BASE_URL: "https://volunteer-relay.brnby.com",
      VIDEO_ALLOWED_ORIGIN: "https://volunteer-relay.brnby.com",
    });
    expect(target.originLabel).toBe("hosted");
  });

  it("refuses hosted capture against loopback or plain http", () => {
    expect(() =>
      resolveTarget({
        VIDEO_TARGET_MODE: "hosted",
        VIDEO_BASE_URL: "http://127.0.0.1:3300",
        VIDEO_ALLOWED_ORIGIN: "http://127.0.0.1:3300",
      }),
    ).toThrow(/https/);
    expect(() =>
      resolveTarget({
        VIDEO_TARGET_MODE: "hosted",
        VIDEO_BASE_URL: "https://localhost:3300",
        VIDEO_ALLOWED_ORIGIN: "https://localhost:3300",
      }),
    ).toThrow(/loopback/);
  });

  it("requires the allowed origin to match exactly", () => {
    expect(() =>
      resolveTarget({
        VIDEO_TARGET_MODE: "hosted",
        VIDEO_BASE_URL: "https://volunteer-relay.brnby.com",
        VIDEO_ALLOWED_ORIGIN: "https://evil.example",
      }),
    ).toThrow(/must equal/);
  });

  it("accepts an explicit loopback rehearsal target", () => {
    const target = resolveTarget({
      VIDEO_TARGET_MODE: "local",
      VIDEO_BASE_URL: "http://127.0.0.1:3300",
      VIDEO_ALLOWED_ORIGIN: "http://127.0.0.1:3300",
    });
    expect(target.originLabel).toBe("local");
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  it("refuses to submit credentials to another origin", () => {
    expect(() =>
      assertOriginAllowed(
        "https://evil.example/sign-in",
        "https://volunteer-relay.brnby.com",
      ),
    ).toThrow(/Refusing to reach/);
    expect(
      assertOriginAllowed(
        "https://volunteer-relay.brnby.com/sign-in",
        "https://volunteer-relay.brnby.com",
      ).host,
    ).toBe("volunteer-relay.brnby.com");
  });
});

describe("environment parsing", () => {
  it("reads KEY=VALUE pairs, quotes and comments without executing anything", () => {
    const values = parseEnvFile(
      [
        "# comment",
        "VIDEO_OWEN_EMAIL=relay.owen@example.com",
        'VIDEO_OWEN_PASSWORD="quoted value"',
        "not a var",
        "lower=case",
      ].join("\n"),
    );
    expect(values.VIDEO_OWEN_EMAIL).toBe("relay.owen@example.com");
    expect(values.VIDEO_OWEN_PASSWORD).toBe("quoted value");
    expect(values.lower).toBeUndefined();
  });

  it("keeps the committed example free of credential values", () => {
    const example = readFileSync(paths.envExample, "utf8");
    const values = parseEnvFile(example);
    for (const [key, value] of Object.entries(values)) {
      if (key.endsWith("_PASSWORD") || key.includes("API_KEY"))
        expect(value).toBe("");
    }
  });
});
