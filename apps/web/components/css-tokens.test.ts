import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every screen renders inside `FoundationRoot`, which defines the --relay-*
// tokens. A literal fallback such as `var(--relay-line, #dce5dc)` can only
// apply outside it, where it drifts from the token and hides real styling
// gaps. These checks keep the stylesheets on the tokens alone.
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokenFile = join(webRoot, "components/foundation/foundation.module.css");

function stylesheets(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...stylesheets(path));
    else if (entry.name.endsWith(".css")) found.push(path);
  }
  return found;
}

/** Every `var(--relay-x, fallback)` in the source, with its fallback text. */
function relayVars(
  source: string,
): { name: string; fallback: string | null }[] {
  const found: { name: string; fallback: string | null }[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf("var(--relay-", from);
    if (start === -1) return found;
    let depth = 0;
    let end = start + 3;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    const inner = source.slice(start + 4, end);
    const comma = inner.indexOf(",");
    found.push(
      comma === -1
        ? { name: inner.trim(), fallback: null }
        : {
            name: inner.slice(0, comma).trim(),
            fallback: inner.slice(comma + 1).trim(),
          },
    );
    from = start + 4;
  }
}

const files = stylesheets(webRoot).map((path) => ({
  path: relative(webRoot, path),
  source: readFileSync(path, "utf8"),
}));

describe("css design tokens", () => {
  it("finds the stylesheets", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("uses no literal fallback inside var(--relay-*)", () => {
    const offenders = files.flatMap(({ path, source }) =>
      relayVars(source)
        .filter(
          ({ fallback }) => fallback !== null && !fallback.includes("var("),
        )
        .map(({ name, fallback }) => `${path}: var(${name}, ${fallback})`),
    );
    expect(offenders).toEqual([]);
  });

  it("only uses tokens that FoundationRoot defines", () => {
    const defined = new Set(
      [
        ...readFileSync(tokenFile, "utf8").matchAll(
          /(--relay-[a-z0-9-]+)\s*:/g,
        ),
      ].map((match) => match[1]),
    );
    const undefinedUses = files.flatMap(({ path, source }) =>
      relayVars(source)
        .filter(({ name }) => !defined.has(name))
        .map(({ name }) => `${path}: ${name}`),
    );
    expect(undefinedUses).toEqual([]);
  });

  it("detects a literal fallback", () => {
    expect(relayVars("a{color:var(--relay-ink, #172b26)}")).toEqual([
      { name: "--relay-ink", fallback: "#172b26" },
    ]);
    expect(
      relayVars("a{padding:var(--relay-space-4, var(--other, 1px))}")[0]
        ?.fallback,
    ).toBe("var(--other, 1px)");
  });
});
