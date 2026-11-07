import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import oracle from "./expected-results.json" with { type: "json" };
import { sources } from "./sources.ts";

it("has a complete separate oracle, two tenants and intact synthetic images", () => {
  expect(sources).toHaveLength(28);
  expect(new Set(sources.map((s) => s.organizationId)).size).toBe(2);
  expect(oracle.cases.map((c) => c.sourceId)).toEqual(
    sources.map((s) => s.sourceId),
  );
  for (const s of sources)
    for (const a of s.attachments) {
      const bytes = readFileSync(
        new URL(`./images/${a.storageKey.split("/").at(-1)}`, import.meta.url),
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(a.sha256);
    }
  expect(oracle.urgentSourceIds).toEqual(["source-07"]);
});
