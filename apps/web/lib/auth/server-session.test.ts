import { describe, expect, it } from "vitest";
import { sessionPresent } from "./server-session.ts";

// The SDK resolves absent, expired and malformed cookies to no session, so the
// decision must key on a user id and not on the presence of an object.
describe("sessionPresent", () => {
  it("is false for no result", () => {
    expect(sessionPresent(undefined)).toBe(false);
    expect(sessionPresent(null)).toBe(false);
  });

  it("is false when the response has no user", () => {
    expect(sessionPresent({})).toBe(false);
    expect(sessionPresent({ response: null })).toBe(false);
    expect(sessionPresent({ response: {} })).toBe(false);
    expect(sessionPresent({ response: { user: null } })).toBe(false);
  });

  // A user object without an id must not count: that is exactly the shape a
  // partially-decoded or malformed cookie produces.
  it("is false when the user has no id", () => {
    expect(sessionPresent({ response: { user: {} } })).toBe(false);
    expect(sessionPresent({ response: { user: { id: "" } } })).toBe(false);
  });

  it("is true for a user with an id", () => {
    expect(sessionPresent({ response: { user: { id: "user-1" } } })).toBe(true);
  });
});
