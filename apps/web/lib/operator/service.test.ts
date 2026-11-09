import { describe, expect, it } from "vitest";
import type {
  OperatorAuditEntry,
  OperatorStore,
  OperatorTransaction,
} from "./service.ts";
import {
  createOperatorService,
  decodeCursor,
  encodeCursor,
  escapeLike,
  postgresCode,
} from "./service.ts";

type Member = { membershipId: string; userId: string; role: string };

interface State {
  organizations: {
    organizationId: string;
    name: string;
    slug: string;
    createdAt: string;
    members: Member[];
  }[];
  accounts: { email: string; userId: string; password: boolean }[];
  audits: OperatorAuditEntry[];
  failNext: boolean;
}

function fakeStore(seed: Partial<State> = {}) {
  const state: State = {
    accounts: seed.accounts ?? [],
    audits: seed.audits ?? [],
    failNext: seed.failNext ?? false,
    // Cloned so one test's role change cannot leak into the next fixture.
    organizations: (seed.organizations ?? []).map((row) => ({
      ...row,
      members: row.members.map((member) => ({ ...member })),
    })),
  };
  const audit = async (entry: OperatorAuditEntry) => {
    state.audits.push(entry);
  };
  const tx: OperatorTransaction = {
    async verifiedAccount(email) {
      const found = state.accounts.find(
        (account) => account.email === email.toLowerCase(),
      );
      return found ? { userId: found.userId } : null;
    },
    async hasPassword(userId) {
      return state.accounts.find((a) => a.userId === userId)?.password === true;
    },
    async lockOrganizationName() {},
    async organizationTaken({ name, slug }) {
      return state.organizations.some(
        (organization) =>
          organization.slug === slug ||
          organization.name.toLowerCase() === name.toLowerCase(),
      );
    },
    async insertOrganization({ organizationId, name, slug }) {
      state.organizations.push({
        organizationId,
        name,
        slug,
        createdAt: "2026-01-01T00:00:00.000Z",
        members: [],
      });
    },
    async insertMembership({ membershipId, organizationId, userId, role }) {
      state.organizations
        .find((organization) => organization.organizationId === organizationId)
        ?.members.push({ membershipId, userId, role });
    },
    async insertSettings() {},
    async lockOrganization(organizationId) {
      return state.organizations.some(
        (organization) => organization.organizationId === organizationId,
      );
    },
    async hasMembership({ organizationId, userId }) {
      return (
        state.organizations
          .find(
            (organization) => organization.organizationId === organizationId,
          )
          ?.members.some((member) => member.userId === userId) === true
      );
    },
    async lockMemberRows({ organizationId }) {
      const organization = state.organizations.find(
        (row) => row.organizationId === organizationId,
      );
      return organization
        ? organization.members.map((member) => ({ ...member }))
        : [];
    },
    async updateRole({ organizationId, membershipId, role }) {
      const member = state.organizations
        .find((row) => row.organizationId === organizationId)
        ?.members.find((row) => row.membershipId === membershipId);
      if (member) member.role = role;
    },
    recordAudit: audit,
  };
  const store: OperatorStore = {
    async transaction(run) {
      if (state.failNext) throw new Error("unavailable");
      return run(tx);
    },
    async listOrganizations({ pattern, after, limit }) {
      const all = state.organizations
        .filter((organization) =>
          pattern === null ? true : organization.name.includes(pattern),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .filter((organization) =>
          after === null
            ? true
            : [
                organization.name.toLowerCase(),
                organization.organizationId,
              ].join("\u0000") > after.join("\u0000"),
        );
      const page = all.slice(0, limit);
      return {
        hasMore: all.length > page.length,
        rows: page.map((organization) => ({
          organizationId: organization.organizationId,
          sortName: organization.name.toLowerCase(),
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt,
          members: {
            owner: organization.members.filter((m) => m.role === "owner")
              .length,
            coordinator: organization.members.filter(
              (m) => m.role === "coordinator",
            ).length,
            volunteer: organization.members.filter(
              (m) => m.role === "volunteer",
            ).length,
            reportReader: organization.members.filter(
              (m) => m.role === "report-reader",
            ).length,
            total: organization.members.length,
          },
          owners: organization.members
            .filter((m) => m.role === "owner")
            .map((m) => ({
              membershipId: m.membershipId,
              name: m.membershipId,
              maskedEmail: "o•••@example.org",
              joinedAt: organization.createdAt,
            })),
          pendingInvitations: 0,
        })),
      };
    },
    async getOrganization(organizationId) {
      const organization = state.organizations.find(
        (row) => row.organizationId === organizationId,
      );
      if (!organization) return null;
      return {
        organization: {
          organizationId,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt,
          members: {
            owner: organization.members.filter((m) => m.role === "owner")
              .length,
            coordinator: organization.members.filter(
              (m) => m.role === "coordinator",
            ).length,
            volunteer: organization.members.filter(
              (m) => m.role === "volunteer",
            ).length,
            reportReader: 0,
            total: organization.members.length,
          },
          owners: [],
          ownersTruncated: false,
          pendingInvitations: 0,
        },
        members: organization.members.map((member) => ({
          membershipId: member.membershipId,
          name: member.membershipId,
          maskedEmail: "o•••@example.org",
          role: member.role as "owner",
          joinedAt: organization.createdAt,
        })),
        membersTruncated: false,
      };
    },
  };
  return { state, service: createOperatorService(store) };
}

const actor = { userId: "operator-1" };
const coordinator = {
  membershipId: "member-1",
  userId: "user-1",
  role: "coordinator",
};
const ownerA = { membershipId: "member-2", userId: "user-2", role: "owner" };
const ownerB = { membershipId: "member-3", userId: "user-3", role: "owner" };
const volunteer = {
  membershipId: "member-4",
  userId: "user-4",
  role: "volunteer",
};

const organization = {
  organizationId: "org-1",
  name: "Tidepath",
  slug: "tidepath",
  createdAt: "2026-01-01T00:00:00.000Z",
  members: [coordinator, ownerA, ownerB, volunteer],
};

describe("operator service reads", () => {
  it("validates the list query before touching the store", async () => {
    const { service } = fakeStore({ organizations: [organization] });
    for (const query of [
      { q: "t" },
      { q: "50%" },
      { cursor: "not a cursor" },
    ]) {
      const result = await service.list(query as never);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("reports truncation from the owner count, not from the returned rows", async () => {
    const { service } = fakeStore({ organizations: [organization] });
    const result = await service.list({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.organizations).toHaveLength(1);
    expect(result.value.organizations[0]?.members.owner).toBe(2);
    expect(result.value.organizations[0]?.ownersTruncated).toBe(false);
  });

  it("returns a cursor only when another page exists", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...organization,
      organizationId: `org-${index}`,
      name: `Organization ${String(index).padStart(3, "0")}`,
    }));
    const { service } = fakeStore({ organizations: many });
    const first = await service.list({});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.organizations).toHaveLength(50);
    expect(first.value.nextCursor).not.toBeNull();
    const second = await service.list({ cursor: first.value.nextCursor ?? "" });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.organizations).toHaveLength(10);
    expect(second.value.nextCursor).toBeNull();
  });

  it("refuses an unknown organization and an oversized id", async () => {
    const { service } = fakeStore({ organizations: [organization] });
    const missing = await service.detail({
      organizationId: "org-missing",
      correlationId: "c",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
    const invalid = await service.detail({
      organizationId: "x".repeat(129),
      correlationId: "c",
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("VALIDATION");
  });

  it("maps a store failure to a retryable dependency error", async () => {
    const { service, state } = fakeStore({ organizations: [organization] });
    state.failNext = true;
    const result = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DEPENDENCY_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
    }
  });
});

describe("operator service ownership changes", () => {
  it("promotes a coordinator and audits the operator, without their address", async () => {
    const { service, state } = fakeStore({ organizations: [organization] });
    const result = await service.setMemberRole({
      actor,
      correlationId: "corr-1",
      command: {
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
      },
    });
    expect(result.ok).toBe(true);
    expect(
      state.organizations[0]?.members.find((m) => m.membershipId === "member-1")
        ?.role,
    ).toBe("owner");
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]?.actor).toEqual({ userId: "operator-1" });
    expect(JSON.stringify(state.audits[0])).not.toContain("@");
    expect(state.audits[0]?.before).toEqual({ role: "coordinator" });
    expect(state.audits[0]?.after).toEqual({ role: "owner" });
  });

  it("revokes ownership when another owner remains", async () => {
    const { service, state } = fakeStore({ organizations: [organization] });
    const result = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-2",
        role: "coordinator",
        expectedRole: "owner",
      },
    });
    expect(result.ok).toBe(true);
    expect(
      state.organizations[0]?.members.find((m) => m.membershipId === "member-2")
        ?.role,
    ).toBe("coordinator");
    expect(state.audits).toHaveLength(1);
  });

  it("refuses to leave an organization without an owner", async () => {
    const { service, state } = fakeStore({
      organizations: [{ ...organization, members: [ownerA, volunteer] }],
    });
    const result = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-2",
        role: "coordinator",
        expectedRole: "owner",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    expect(
      state.organizations[0]?.members.find((m) => m.membershipId === "member-2")
        ?.role,
    ).toBe("owner");
    expect(state.audits).toHaveLength(0);
  });

  it("refuses an operator changing their own membership", async () => {
    const { service, state } = fakeStore({
      organizations: [
        {
          ...organization,
          members: [
            ownerA,
            {
              membershipId: "member-self",
              userId: "operator-1",
              role: "volunteer",
            },
          ],
        },
      ],
    });
    const result = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-self",
        role: "owner",
        expectedRole: "volunteer",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(
      state.organizations[0]?.members.find(
        (m) => m.membershipId === "member-self",
      )?.role,
    ).toBe("volunteer");
    expect(state.audits).toHaveLength(0);
  });

  it("conflicts on a stale expected role instead of overwriting", async () => {
    const { service, state } = fakeStore({ organizations: [organization] });
    const result = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "owner",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    expect(state.audits).toHaveLength(0);
  });

  it("only grants ownership and only revokes ownership", async () => {
    const { service } = fakeStore({ organizations: [organization] });
    const alreadyOwner = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-3",
        role: "owner",
        expectedRole: "owner",
      },
    });
    // The stale-role guard fires first for an owner who is still an owner.
    expect(alreadyOwner.ok).toBe(false);
    const revokeVolunteer = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-4",
        role: "coordinator",
        expectedRole: "volunteer",
      },
    });
    expect(revokeVolunteer.ok).toBe(false);
    if (!revokeVolunteer.ok)
      expect(revokeVolunteer.error.code).toBe("VALIDATION");
  });

  it("refuses an unknown organization or membership", async () => {
    const { service } = fakeStore({ organizations: [organization] });
    const missingOrganization = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-2",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
      },
    });
    expect(missingOrganization.ok).toBe(false);
    if (!missingOrganization.ok)
      expect(missingOrganization.error.code).toBe("NOT_FOUND");
    const missingMember = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-9",
        role: "owner",
        expectedRole: "coordinator",
      },
    });
    expect(missingMember.ok).toBe(false);
    if (!missingMember.ok) expect(missingMember.error.code).toBe("NOT_FOUND");
  });
});

describe("operator organization creation", () => {
  const command = {
    name: "Harbor Collective",
    slug: "harbor-collective",
    timezone: "America/New_York",
    ownerEmail: "Owner@Example.org",
  };

  it("creates the organization, its first owner and an attributed audit row", async () => {
    const { service, state } = fakeStore({
      accounts: [
        { email: "owner@example.org", userId: "user-9", password: true },
      ],
    });
    const result = await service.createOrganization({
      actor,
      command,
      correlationId: "corr-create",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state.organizations[0]?.organizationId).toBe(
      result.value.organizationId,
    );
    expect(state.organizations[0]?.members).toEqual([
      expect.objectContaining({ userId: "user-9", role: "owner" }),
    ]);
    expect(state.audits[0]?.after).toMatchObject({
      role: "owner",
      organizationCreated: true,
      userId: "user-9",
    });
    expect(state.audits[0]?.correlationId).toBe("corr-create");
  });

  it("refuses an unknown, unverified or passwordless account with one neutral error", async () => {
    for (const accounts of [
      [],
      [{ email: "owner@example.org", userId: "user-9", password: false }],
    ]) {
      const { service, state } = fakeStore({ accounts });
      const result = await service.createOrganization({
        actor,
        command,
        correlationId: "c",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
      expect(state.organizations).toHaveLength(0);
      expect(state.audits).toHaveLength(0);
    }
  });

  it("conflicts on an existing name or slug and writes nothing", async () => {
    const { service, state } = fakeStore({
      accounts: [
        { email: "owner@example.org", userId: "user-9", password: true },
      ],
      organizations: [organization],
    });
    for (const patch of [{ slug: "tidepath" }, { name: "tidepath" }]) {
      const result = await service.createOrganization({
        actor,
        command: { ...command, ...patch },
        correlationId: "c",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("CONFLICT");
    }
    expect(state.organizations).toHaveLength(1);
    expect(state.audits).toHaveLength(0);
  });
});

describe("operator separation of duties", () => {
  it("never makes the operator an owner of a new organization", async () => {
    const { service, state } = fakeStore({
      accounts: [
        { email: "operator@example.org", userId: "operator-1", password: true },
      ],
    });
    const result = await service.createOrganization({
      actor,
      command: {
        name: "Harbor Collective",
        slug: "harbor-collective",
        timezone: "America/New_York",
        ownerEmail: "operator@example.org",
      },
      correlationId: "c",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(state.organizations).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });

  it("refuses to manage ownership in an organization the operator belongs to", async () => {
    const { service, state } = fakeStore({
      organizations: [
        {
          ...organization,
          members: [
            ...organization.members,
            {
              membershipId: "member-op",
              userId: "operator-1",
              role: "volunteer",
            },
          ],
        },
      ],
    });
    const result = await service.setMemberRole({
      actor,
      correlationId: "c",
      command: {
        organizationId: "org-1",
        membershipId: "member-1",
        role: "owner",
        expectedRole: "coordinator",
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("FORBIDDEN");
    expect(
      state.organizations[0]?.members.find((m) => m.membershipId === "member-1")
        ?.role,
    ).toBe("coordinator");
    expect(state.audits).toHaveLength(0);
  });

  it("maps a unique violation to a conflict, not an outage", () => {
    expect(postgresCode({ code: "23505" })).toBe("23505");
    expect(postgresCode({ cause: { cause: { code: "23505" } } })).toBe("23505");
    expect(postgresCode(new Error("x"))).toBeUndefined();
  });
});

describe("operator cursor helpers", () => {
  it("round-trips a keyset cursor and refuses anything else", () => {
    const cursor = encodeCursor("tidepath", "org-1");
    expect(decodeCursor(cursor)).toEqual(["tidepath", "org-1"]);
    for (const value of ["", "not-base64", encodeCursor("x", "y").slice(0, 4)])
      expect(decodeCursor(value)).not.toEqual(["tidepath", "org-1"]);
  });

  it("escapes LIKE metacharacters", () => {
    expect(escapeLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
  });
});
