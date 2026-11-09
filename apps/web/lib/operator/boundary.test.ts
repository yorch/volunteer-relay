import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const directory = import.meta.dirname;
const sources = readdirSync(directory)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({
    file,
    text: readFileSync(join(directory, file), "utf8"),
  }));

/**
 * The operator console is a separate authority surface. It must never borrow
 * tenant machinery: no `TenantContext`, no product handler, no product
 * extensions and no tenant authorization service. Reusing any of them would let
 * a global capability be expressed as a synthetic tenant, which is exactly the
 * boundary this task exists to keep.
 */
describe("operator module boundary", () => {
  it("has sources to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  // Comments explain what the module deliberately does not use, so the import
  // check reads only import statements.
  const imports = (text: string) =>
    [...text.matchAll(/^import[\s\S]*?from\s+"[^"]+";/gm)]
      .map((match) => match[0])
      .join("\n");
  const code = (text: string) =>
    text
      .replaceAll(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

  for (const { file, text } of sources) {
    it(`${file} does not import tenant authority`, () => {
      for (const forbidden of [
        "TenantContext",
        "createProductHandler",
        "createProductExtensions",
        "createTenantAuthorization",
        "productFailure",
      ])
        expect(imports(text)).not.toContain(forbidden);
      expect(code(text)).not.toContain("authorization.resolve");
    });

    it(`${file} never reads an organization from the request`, () => {
      for (const forbidden of [
        "x-relay-org",
        "activeOrganizationId",
        "organizations/select",
      ])
        expect(code(text)).not.toContain(forbidden);
    });
  }
});
