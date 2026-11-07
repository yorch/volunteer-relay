import { expect, it } from "vitest";
import { parseEnvironment } from "./index.ts";

it("rejects unsafe production defaults", () => {
  expect(() => parseEnvironment({ NODE_ENV: "production" })).toThrow();
  expect(() =>
    parseEnvironment({
      NODE_ENV: "production",
      BETTER_AUTH_SECRET: "x".repeat(32),
      DEMO_MODE: "true",
    }),
  ).toThrow();
  expect(parseEnvironment({}).DEMO_MODE).toBe("false");
});
