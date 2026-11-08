import { beforeEach, describe, expect, it, vi } from "vitest";

const isSignedIn = vi.fn();
const redirect = vi.fn((target: string) => {
  throw new Error(`NEXT_REDIRECT:${target}`);
});

vi.mock("../../lib/auth/server-session.ts", () => ({ isSignedIn }));
vi.mock("next/navigation", () => ({ redirect }));

const signInPage = await import("./sign-in/page.tsx");
const signUpPage = await import("./sign-up/page.tsx");

// These cover the regression that produced the bug report: the pages must ask
// the server whether a session exists, and send a signed-in visitor somewhere
// usable instead of rendering the form again.
beforeEach(() => {
  isSignedIn.mockReset();
  redirect.mockClear();
});

describe("sign-in page", () => {
  it("redirects a signed-in visitor to the workspace", async () => {
    isSignedIn.mockResolvedValue(true);
    await expect(signInPage.default()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/workspace");
  });

  it("renders the form when nobody is signed in", async () => {
    isSignedIn.mockResolvedValue(false);
    await expect(signInPage.default()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("sign-up page", () => {
  it("redirects a signed-in visitor to the workspace", async () => {
    isSignedIn.mockResolvedValue(true);
    await expect(signUpPage.default()).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/workspace");
  });

  it("renders the form when nobody is signed in", async () => {
    isSignedIn.mockResolvedValue(false);
    await expect(signUpPage.default()).resolves.toBeTruthy();
    expect(redirect).not.toHaveBeenCalled();
  });
});
