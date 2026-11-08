import {
  ORGANIZATION_ASSERTION_HEADER,
  type TenantContext,
} from "@relay/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProductHandler, type ProductHttpDependencies } from "./http.ts";

// Synthetic tenants: the session resolves to "org-tidepath"; the user is also
// a member of "org-harbor" (the other tab); "org-zeta-foreign" is an
// organization the user does not belong to.
const RESOLVED = "org-tidepath";
const OTHER_MEMBER_ORG = "org-harbor";
const FOREIGN_ORG = "org-zeta-foreign";
const APP = "http://localhost:3000";
const NEUTRAL = "The workspace changed in another tab. Refresh to continue.";

const context: TenantContext = {
  organizationId: RESOLVED,
  actor: {
    kind: "user",
    userId: "user-synthetic",
    membershipId: "membership-synthetic",
    role: "coordinator",
  },
  correlationId: "corr-synthetic",
};
const ok = <T>(value: T) => ({ ok: true as const, value });

let writes: string[];
let deps: ProductHttpDependencies;
let handle: (request: Request) => Promise<Response>;

beforeEach(() => {
  writes = [];
  const record = (name: string) =>
    vi.fn(async () => {
      writes.push(name);
      return ok({ recorded: name });
    });
  deps = {
    appUrl: APP,
    resolve: vi.fn(async () =>
      ok({
        context,
        organization: {
          organizationId: RESOLVED,
          membershipId: "membership-synthetic",
          name: "Tidepath",
          slug: "tidepath",
          role: "coordinator" as const,
        },
      }),
    ),
    authorization: { require: vi.fn(async () => ok(undefined)) },
    sources: { accept: record("source") },
    processing: {
      getSource: vi.fn(async () => ({
        ok: false as const,
        error: {
          code: "NOT_FOUND" as const,
          message: "missing",
          correlationId: "c",
          retryable: false,
        },
      })),
      listSourceStatuses: vi.fn(async () => ok([])),
      listQueue: vi.fn(async () => ok([])),
      decide: record("review"),
    },
    ledger: {
      listContributions: vi.fn(async () => ok([])),
      summarize: vi.fn(async () => ok(null)),
      recordActivity: record("activity"),
      transitionContribution: record("contribution"),
    },
    needs: {
      list: vi.fn(async () => ok([])),
      create: record("need"),
      transition: record("need-transition"),
    },
    members: vi.fn(async () => []),
    extensions: vi.fn(async (_context, path, request) => {
      if (path !== "import" && path !== "source-photo") return null;
      await request.formData();
      writes.push(path);
      return ok({ recorded: path });
    }),
  } as unknown as ProductHttpDependencies;
  handle = createProductHandler(deps);
});

function jsonPost(path: string, body: unknown, org?: string | string[]) {
  const headers = new Headers({
    origin: APP,
    "content-type": "application/json",
  });
  for (const value of org === undefined ? [] : [org].flat())
    headers.append(ORGANIZATION_ASSERTION_HEADER, value);
  return new Request(`${APP}/api/product/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
function multipartPost(path: string, org?: string) {
  const form = new FormData();
  form.set("idempotencyKey", "key-synthetic-1");
  form.set("text", "Synthetic note");
  form.set("file", new Blob([new Uint8Array([1, 2, 3])]), "synthetic.png");
  const headers = new Headers({ origin: APP });
  if (org !== undefined) headers.set(ORGANIZATION_ASSERTION_HEADER, org);
  return new Request(`${APP}/api/product/${path}`, {
    method: "POST",
    headers,
    body: form,
  });
}
const needBody = {
  schemaVersion: 1,
  idempotencyKey: "need-key-synthetic",
  category: "Synthetic supplies",
  urgency: "routine",
  summary: "Synthetic water delivery",
  provisional: false,
  dueAt: null,
  acknowledgeBy: null,
  origin: { kind: "staff", reason: "Synthetic staff entry" },
};
const sourceBody = {
  schemaVersion: 1,
  idempotencyKey: "source-key-synthetic",
  text: "Synthetic volunteer note",
};

const routes: Array<[string, (org?: string) => Request, string]> = [
  ["need create", (org) => jsonPost("need", needBody, org), "need"],
  ["source submit", (org) => jsonPost("sources", sourceBody, org), "source"],
  ["import", (org) => multipartPost("import", org), "import"],
  ["photo", (org) => multipartPost("source-photo", org), "source-photo"],
];

describe("organization assertion header", () => {
  describe.each(routes)("%s", (_name, build, write) => {
    it("rejects a mismatch with a neutral 409 and performs no write", async () => {
      const response = await handle(build(OTHER_MEMBER_ORG));
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(text).not.toContain(RESOLVED);
      expect(text).not.toContain(OTHER_MEMBER_ORG);
      const body = JSON.parse(text);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("CONFLICT");
      expect(body.error.message).toBe(NEUTRAL);
      expect(body.error.retryable).toBe(false);
      expect(writes).toEqual([]);
      expect(deps.extensions).not.toHaveBeenCalled();
    });
    it("proceeds when the assertion matches", async () => {
      const response = await handle(build(RESOLVED));
      expect(response.status).toBe(200);
      expect(writes).toEqual([write]);
    });
    it("proceeds unchanged when the header is absent", async () => {
      const response = await handle(build());
      expect(response.status).toBe(200);
      expect(writes).toEqual([write]);
    });
  });

  it("answers a forged non-member organization exactly like a member mismatch", async () => {
    const forged = await handle(jsonPost("need", needBody, FOREIGN_ORG));
    const member = await handle(jsonPost("need", needBody, OTHER_MEMBER_ORG));
    expect(forged.status).toBe(409);
    expect(member.status).toBe(409);
    const forgedText = await forged.text();
    expect(forgedText).not.toContain(FOREIGN_ORG);
    expect(forgedText).not.toContain(RESOLVED);
    const forgedBody = JSON.parse(forgedText);
    const memberBody = await member.json();
    const { correlationId: _a, ...forgedError } = forgedBody.error;
    const { correlationId: _b, ...memberError } = memberBody.error;
    expect(forgedError).toEqual(memberError);
    expect(writes).toEqual([]);
  });

  it.each([
    ["empty", ""],
    ["too long", "o".repeat(129)],
    ["invalid characters", "org tidepath"],
    ["repeated", [RESOLVED, RESOLVED]],
  ] as Array<[string, string | string[]]>)(
    "rejects a %s value with VALIDATION and no write",
    async (_name, value) => {
      const response = await handle(jsonPost("need", needBody, value));
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body.error.code).toBe("VALIDATION");
      expect(JSON.stringify(body)).not.toContain(RESOLVED);
      expect(writes).toEqual([]);
    },
  );

  it("rejects a malformed multipart assertion before the extension runs", async () => {
    const response = await handle(multipartPost("import", "bad/value"));
    expect(response.status).toBe(422);
    expect(deps.extensions).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("ignores the header on GET", async () => {
    const response = await handle(
      new Request(`${APP}/api/product/workspace`, {
        headers: { [ORGANIZATION_ASSERTION_HEADER]: OTHER_MEMBER_ORG },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.value.organization.organizationId).toBe(RESOLVED);
  });
});
