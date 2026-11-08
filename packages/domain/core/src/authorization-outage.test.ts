import type { AuthorizationService, TenantContext } from "@relay/contracts";
import { expect, it } from "vitest";
import { createAttachmentReader } from "./attachments/attachment-reader.ts";
import type { DomainStore } from "./domain-store.ts";
import { createLedgerService } from "./ledger/ledger-service.ts";
import { createSourceRepository } from "./sources/source-repository.ts";
import type { SourceStore } from "./sources/source-store.ts";

const context: TenantContext = {
  organizationId: "org",
  actor: { kind: "user", userId: "u", membershipId: "m", role: "volunteer" },
  correlationId: "c",
};
const authorization: AuthorizationService = {
  async require() {
    return {
      ok: false,
      error: {
        code: "DEPENDENCY_UNAVAILABLE",
        message: "Unavailable",
        correlationId: "c",
        retryable: true,
      },
    };
  },
  async resolve() {
    throw new Error("unexpected");
  },
};
it("preserves authorization outages before trying a less privileged read path", async () => {
  const ledger = createLedgerService({
    authorization,
    store: {} as DomainStore,
  });
  const sources = createSourceRepository({
    authorization,
    store: {} as SourceStore,
  });
  const attachments = createAttachmentReader({
    authorization,
    metadata: {
      async find() {
        throw new Error("must not read metadata");
      },
    },
    blobs: {
      async read() {
        throw new Error("must not read bytes");
      },
    },
  });
  for (const result of [
    await ledger.listContributions(context, {}),
    await sources.get(context, "s", 1),
    await attachments.read(context, "s", "a"),
  ]) {
    expect(result).toMatchObject({
      ok: false,
      error: { code: "DEPENDENCY_UNAVAILABLE", retryable: true },
    });
  }
});
