import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { environmentSchema } from "../packages/config/src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const compose = readFileSync(`${root}compose.production.yaml`, "utf8");
const operator = readFileSync(
  `${root}infra/production/production.env.sample`,
  "utf8",
);
const runtime = readFileSync(
  `${root}infra/production/runtime.env.sample`,
  "utf8",
);

/** Compose variables the operator environment must supply, and those it may. */
function composeVariables(): { required: string[]; optional: string[] } {
  const required = new Set<string>();
  const optional = new Set<string>();
  for (const match of compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(:\?|:-)/g)) {
    const name = match[1];
    const modifier = match[2];
    if (name === undefined) continue;
    // `:?` fails the deploy when unset, so the sample has to provide it.
    (modifier === ":?" ? required : optional).add(name);
  }
  return { required: [...required].sort(), optional: [...optional].sort() };
}

function assignments(file: string) {
  const active = new Map<string, string>();
  const documented = new Set<string>();
  for (const raw of file.split("\n")) {
    const match = /^(#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
    if (!match) continue;
    const name = match[2];
    if (name === undefined) continue;
    documented.add(name);
    if (!match[1]) active.set(name, match[3] ?? "");
  }
  return { active, documented };
}

// A sample that omits a required key only fails at deploy time, on the host,
// with Compose's interpolation error instead of a test.
it("provides every variable compose.production.yaml requires", () => {
  const { active } = assignments(operator);
  const { required } = composeVariables();
  expect(required.length).toBeGreaterThan(0);
  for (const name of required) {
    expect(active.has(name), `${name} missing from production.env.sample`).toBe(
      true,
    );
    expect(active.get(name)?.trim(), `${name} is empty`).not.toBe("");
  }
});

// A stray key looks configured and does nothing. Keep the sample honest about
// what this profile actually reads.
it("documents only variables the production profile reads", () => {
  const { active } = assignments(operator);
  const { required, optional } = composeVariables();
  // Not interpolated by Compose, but used by the runbooks and backup scripts.
  const usedOutsideCompose = new Set(["COMPOSE_PROJECT_NAME"]);
  const known = new Set([...required, ...optional, ...usedOutsideCompose]);
  for (const name of active.keys()) {
    expect(known.has(name), `production.env.sample sets unknown ${name}`).toBe(
      true,
    );
  }
});

// Production consumes what the release workflow published, not a local build:
// a tag can move, and a locally built image has no reviewed release behind it.
it("pins the release workflow's GHCR images by digest", () => {
  const { active } = assignments(operator);
  const images: [string, string][] = [
    ["RELAY_WEB_IMAGE", "-web"],
    ["RELAY_WORKER_IMAGE", "-worker"],
  ];
  for (const [name, suffix] of images) {
    const value = active.get(name) ?? "";
    expect(value.startsWith("ghcr.io/"), `${name} must come from ghcr.io`).toBe(
      true,
    );
    expect(value.includes("@sha256:"), `${name} must pin a digest`).toBe(true);
    expect(
      value.split("@")[0]?.endsWith(suffix),
      `${name} must be the ${suffix} image`,
    ).toBe(true);
  }
});

it("keeps the ingress name optional", () => {
  const { active } = assignments(operator);
  const { optional } = composeVariables();
  // TRAEFIK_NAME carries a default, so a single-deployment host needs no entry.
  expect(optional).toContain("TRAEFIK_NAME");
  expect(active.get("TRAEFIK_NAME")).toBe("relay");
});

it("documents every runtime setting the application parses", () => {
  const { documented } = assignments(runtime);
  const expected = [
    ...Object.keys(environmentSchema.shape),
    // Read directly by the retention tooling, outside the config schema.
    "RETENTION_LEDGER_KEY",
  ];
  for (const name of expected) {
    expect(
      documented.has(name),
      `${name} missing from runtime.env.sample`,
    ).toBe(true);
  }
});

it("invents no runtime variable", () => {
  const { active } = assignments(runtime);
  const known = new Set([
    ...Object.keys(environmentSchema.shape),
    "RETENTION_LEDGER_KEY",
  ]);
  for (const name of active.keys()) {
    expect(known.has(name), `runtime.env.sample sets unknown ${name}`).toBe(
      true,
    );
  }
});

// The sample is safe to copy only if a blind copy fails loudly. Production
// rejects a missing BETTER_AUTH_SECRET, so the secrets stay commented out.
it("leaves secrets unset so a copied sample cannot start", () => {
  const { active } = assignments(runtime);
  for (const name of [
    "BETTER_AUTH_SECRET",
    "RETENTION_LEDGER_KEY",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "OPENAI_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
  ]) {
    expect(active.has(name), `${name} must stay commented out`).toBe(false);
  }
});
