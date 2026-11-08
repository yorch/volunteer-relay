import { expect, test } from "@playwright/test";
import { chooseOption } from "../helpers/controls.js";

const organization = {
  organizationId: "org-1",
  name: "Community",
  slug: "community",
  role: "volunteer",
  membershipId: "member-1",
};
const snapshot = {
  organization,
  members: [],
  sources: [],
  queue: [],
  contributions: [
    {
      schemaVersion: 1,
      organizationId: "org-1",
      contributionId: "c-1",
      activityId: "a-1",
      revision: 1,
      membershipId: "member-1",
      durationMinutes: null,
      status: "pending",
      origin: { kind: "staff", reason: "Entry" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ],
  needs: [],
  summary: null,
};

test("volunteer submits text and sees receipt and unknown duration", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: { currentOrganizationId: "org-1", options: [organization] },
      },
    }),
  );
  let body: Record<string, unknown> = {};
  await page.route("**/api/product/sources", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({
      json: {
        ok: true,
        value: {
          sourceId: "source-1",
          revision: 1,
          status: "received",
          correlationId: "correlation-1",
        },
      },
    });
  });
  await page.goto("/workspace/volunteer");
  await expect(page.getByText("Unknown duration")).toBeVisible();
  await page.getByLabel("Your update").fill("Helped at the garden");
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(
    page.getByText("Receipt: source-1", { exact: false }),
  ).toBeVisible();
  expect(body).toMatchObject({
    schemaVersion: 1,
    text: "Helped at the garden",
  });
  expect(body.idempotencyKey).toEqual(expect.any(String));
  expect(body).not.toHaveProperty("organizationId");
});

test("report reader sees only summary and is denied inbox", async ({
  page,
}) => {
  const reader = {
    ...snapshot,
    organization: { ...organization, role: "report-reader" },
    contributions: [],
    summary: {
      approvedMinutes: 90,
      approvedContributions: 1,
      activitiesWithApprovedContributions: 1,
      pendingContributions: 1,
      pendingUnknownDuration: 1,
      pendingUnresolvedVolunteer: 0,
    },
  };
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: reader } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      status: 503,
      json: { ok: false, error: { code: "DEPENDENCY_UNAVAILABLE" } },
    }),
  );
  await page.route("**/api/product/reports*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          query: {},
          timezone: "UTC",
          ledger: reader.summary,
          approvedHours: 1.5,
          openNeeds: 0,
          resolvedNeeds: 0,
          averageAcknowledgmentMinutes: null,
          excludedUnknownDate: 2,
        },
      },
    }),
  );
  await page.goto("/workspace/reports");
  await expect(page.getByText("Approved minutes")).toBeVisible();
  await expect(page.getByText("90", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Source inbox" })).toHaveCount(0);
  await page.goto("/workspace/inbox");
  await expect(
    page.getByRole("heading", { name: "Permission denied" }),
  ).toBeVisible();
});

test("staff reviews preserved source with optimistic revision", async ({
  page,
}) => {
  const entry = {
    source: {
      sourceId: "source-1",
      revision: 2,
      text: "Helped for 90 minutes",
      channel: "web",
      receivedAt: "2026-01-01T00:00:00Z",
    },
    revision: 3,
    proposal: {
      runId: "run-1",
      items: [
        {
          kind: "contribution",
          key: "item-1",
          activityKey: "activity-1",
          membershipId: null,
          durationMinutes: 90,
          evidence: [
            {
              kind: "text",
              field: "durationMinutes",
              quote: "90 minutes",
              sourceRevision: 2,
            },
          ],
        },
      ],
      unresolved: [{ field: "membershipId", reason: "Unknown volunteer" }],
    },
  };
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          queue: [entry],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  let body: Record<string, unknown> = {};
  await page.route("**/api/product/review", async (route) => {
    body = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, value: { revision: 4 } } });
  });
  await page.goto("/workspace/inbox");
  await page
    .getByRole("button", { name: "Source source-1 · revision 2" })
    .click();
  await expect(
    page.locator("p").filter({ hasText: "Helped for 90 minutes" }),
  ).toBeVisible();
  await expect(
    page.getByText("Duration minutes: “90 minutes”", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("Membership id: Unknown volunteer"),
  ).toBeVisible();
  await page.getByLabel("Review reason").fill("Confirmed with team");
  await page.getByRole("button", { name: "Accept proposal" }).click();
  await expect(page.getByRole("status")).toContainText("Proposal accepted");
  expect(body).toMatchObject({
    runId: "run-1",
    expectedRevision: 3,
    decision: "accept",
    reason: "Confirmed with team",
  });
  expect(body).not.toHaveProperty("organizationId");
});

test("staff edits preserve evidence and retries reuse the key", async ({
  page,
}) => {
  const evidence = [
    {
      kind: "text",
      field: "durationMinutes",
      quote: "90 minutes",
      sourceRevision: 2,
    },
  ];
  const entry = {
    source: {
      sourceId: "source-1",
      revision: 2,
      text: "Helped for 90 minutes",
      channel: "web",
      receivedAt: "2026-01-01T00:00:00Z",
    },
    revision: 3,
    proposal: {
      runId: "run-1",
      items: [
        {
          kind: "contribution",
          key: "item-1",
          activityKey: "activity-1",
          membershipId: null,
          durationMinutes: 90,
          evidence,
        },
      ],
      unresolved: [],
    },
  };
  let queue = [entry];
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          members: [{ membershipId: "member-1", name: "Alex" }],
          queue,
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/product/review", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) await route.abort();
    else {
      queue = [];
      await route.fulfill({ json: { ok: true, value: { revision: 4 } } });
    }
  });
  await page.goto("/workspace/inbox");
  await page
    .getByRole("button", { name: "Source source-1 · revision 2" })
    .click();
  await chooseOption(page.getByLabel("Volunteer for item-1"), "member-1");
  await page.getByLabel("Duration in minutes for item-1").fill("120");
  await expect(
    page.getByRole("button", { name: "Accept proposal" }),
  ).toBeDisabled();
  await page
    .getByLabel("Review reason", { exact: false })
    .fill("Confirmed with volunteer");
  await page.getByRole("button", { name: "Accept proposal" }).click();
  await expect(
    page.getByText("The service is unavailable. Please try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Accept proposal" }).click();
  await expect(page.getByText("No sources awaiting review.")).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[0]).toMatchObject({
    replacementItems: [
      { membershipId: "member-1", durationMinutes: 120, evidence },
    ],
    reason: "Confirmed with volunteer",
  });
});

test("removing a selected source never carries its reason to another", async ({
  page,
}) => {
  const entry = (id: string) => ({
    source: {
      sourceId: id,
      revision: 1,
      text: `Text ${id}`,
      channel: "web",
      receivedAt: "2026-01-01T00:00:00Z",
    },
    revision: 1,
    proposal: { runId: id, items: [], unresolved: [] },
  });
  let queue = [entry("one"), entry("two")];
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          queue,
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.goto("/workspace/inbox");
  await page.getByRole("button", { name: "Source one · revision 1" }).click();
  if (await page.getByRole("button", { name: "Back to inbox" }).isVisible()) {
    await expect(
      page.getByRole("button", { name: "Back to inbox" }),
    ).toBeFocused();
  }
  await page
    .getByLabel("Review reason", { exact: false })
    .fill("Reason for one");
  if (await page.getByRole("button", { name: "Back to inbox" }).isVisible()) {
    await page.getByRole("button", { name: "Back to inbox" }).click();
    await expect(page.getByLabel("Search updates")).toBeFocused();
  }
  await page.getByLabel("Search updates").fill("two");
  await expect(
    page.getByRole("button", { name: "Accept proposal" }),
  ).toHaveCount(0);
  await expect(page.getByText("Select a source to review.")).toBeVisible();
  await page.getByLabel("Search updates").clear();
  await page.getByRole("button", { name: "Source one · revision 1" }).click();
  await page
    .getByLabel("Review reason", { exact: false })
    .fill("Reason for one");
  queue = [entry("two")];
  if (await page.getByRole("button", { name: "Back to inbox" }).isVisible())
    await page.getByRole("button", { name: "Back to inbox" }).click();
  await page.getByRole("button", { name: "Refresh inbox" }).click();
  await expect(page.getByText("Select a source to review.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Accept proposal" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Source two · revision 1" }).click();
  await expect(page.getByLabel("Review reason", { exact: false })).toHaveValue(
    "",
  );
});

test("report filters and CSV use the same query", async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          members: [{ membershipId: "member-1", name: "Alex" }],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  const urls: string[] = [];
  await page.route("**/api/product/reports?*", (route) => {
    urls.push(route.request().url());
    return route.fulfill({
      json: {
        ok: true,
        value: {
          query: {},
          timezone: "UTC",
          ledger: {
            approvedMinutes: 90,
            approvedContributions: 1,
            activitiesWithApprovedContributions: 1,
            pendingContributions: 0,
            pendingUnknownDuration: 0,
            pendingUnresolvedVolunteer: 0,
          },
          approvedHours: 1.5,
          openNeeds: 1,
          resolvedNeeds: 2,
          averageAcknowledgmentMinutes: null,
          averageResolutionMinutes: 30,
          excludedUnknownDate: 3,
        },
      },
    });
  });
  await page.route("**/api/product/reports", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          query: {},
          timezone: "UTC",
          ledger: {
            approvedMinutes: 90,
            approvedContributions: 1,
            activitiesWithApprovedContributions: 1,
            pendingContributions: 0,
            pendingUnknownDuration: 0,
            pendingUnresolvedVolunteer: 0,
          },
          approvedHours: 1.5,
          openNeeds: 1,
          resolvedNeeds: 2,
          averageAcknowledgmentMinutes: null,
          averageResolutionMinutes: 30,
          excludedUnknownDate: 3,
        },
      },
    }),
  );
  await page.goto("/workspace/reports");
  await page.getByLabel("From date").fill("2026-01-01");
  await page.getByLabel("To date").fill("2026-01-31");
  await page.getByLabel("Program").fill("Garden");
  await chooseOption(
    page.getByLabel("Volunteer", { exact: false }),
    "member-1",
  );
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect.poll(() => urls.length).toBe(1);
  const expected = new URL(urls[0] ?? "http://invalid.test").search;
  await expect(
    page.getByRole("link", { name: "Download aggregate CSV" }),
  ).toHaveAttribute("href", `/api/product/reports.csv${expected}`);
  await expect(page.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(page.getByText("30 min", { exact: true })).toBeVisible();
});

test("import preview blocks errors and requires acknowledgment for duplicates", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          members: [{ membershipId: "member-1", name: "Alex" }],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  let calls = 0;
  let confirmed: Record<string, unknown> = {};
  await page.route("**/api/product/import-preview", (route) => {
    calls++;
    return route.fulfill({
      json: {
        ok: true,
        value: {
          sources: [],
          errors:
            calls === 1 ? [{ row: 1, code: "bad", message: "Bad date" }] : [],
          ambiguousDuplicates:
            calls === 1 ? [] : [{ sourceIds: ["one", "two"], rows: [1, 2] }],
        },
      },
    });
  });
  await page.route("**/api/product/import", (route) => {
    confirmed = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        value: {
          receipts: [
            {
              sourceId: "one",
              revision: 1,
              status: "received",
              correlationId: "c",
            },
          ],
        },
      },
    });
  });
  await page.goto("/workspace/import");
  await page
    .getByLabel("Import text")
    .fill("id,author,text,timestamp\n1,Alex,Hello,2026-01-01");
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText("Row 1: Bad date (bad)")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm import" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm import" }),
  ).toBeDisabled();
  await page.getByLabel("Preserve possible duplicates for review").check();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("1 updates received.")).toBeVisible();
  expect(confirmed).toMatchObject({
    format: "csv",
    dateFormat: "ISO",
    timezone: "UTC",
    authorMapping: {},
    allowAmbiguous: true,
  });
  expect(confirmed.idempotencyKey).toEqual(expect.any(String));
});

test("photo retries reuse the submission key", async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  const bodies: string[] = [];
  await page.route("**/api/product/source-photo", async (route) => {
    bodies.push(route.request().postData() ?? "");
    if (bodies.length === 1) await route.abort();
    else
      await route.fulfill({
        json: {
          ok: true,
          value: {
            sourceId: "photo-1",
            revision: 1,
            status: "received",
            correlationId: "c",
          },
        },
      });
  });
  await page.goto("/workspace/volunteer");
  await page.getByLabel("Your update").fill("Garden photo");
  await page.getByLabel("Photo", { exact: false }).setInputFiles({
    name: "garden.png",
    mimeType: "image/png",
    buffer: Buffer.from("synthetic"),
  });
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(
    page.getByText("The service is unavailable. Please try again."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Send update" }).click();
  await expect(
    page.getByText("Receipt: photo-1", { exact: false }),
  ).toBeVisible();
  const keys = bodies.map(
    (body) => body.match(/name="idempotencyKey"\r\n\r\n([^\r]+)/)?.[1],
  );
  expect(keys[0]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
  expect(keys[1]).toBe(keys[0]);
});

test("staff overview uses workspace and report data", async ({ page }) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          needs: [
            {
              needId: "n1",
              summary: "Deliver supplies",
              status: "new",
              urgency: "urgent",
              provisional: true,
              dueAt: null,
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/reports", (route) =>
    route.fulfill({ json: { ok: true, value: { approvedHours: 3 } } }),
  );
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("3 hrs")).toBeVisible();
  await expect(page.getByText("Deliver supplies")).toBeVisible();
  await expect(page.getByText("1 urgent need")).toBeVisible();
});

test("ledger inspects the contribution source and shows access denial", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          contributions: [
            {
              ...snapshot.contributions[0],
              origin: {
                kind: "source",
                sourceId: "source-original",
                sourceRevision: 2,
              },
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  let sourceRequest = "";
  await page.route("**/api/product/source?*", (route) => {
    sourceRequest = route.request().url();
    return route.fulfill({
      status: 403,
      json: { ok: false, error: { code: "FORBIDDEN" } },
    });
  });
  await page.goto("/workspace/activities");
  await page.getByText("Details and correction").click();
  await page
    .getByRole("button", { name: "Inspect current source evidence" })
    .click();
  await expect(
    page.getByText("You do not have permission to access this workspace."),
  ).toBeVisible();
  expect(new URL(sourceRequest).searchParams.get("sourceId")).toBe(
    "source-original",
  );
  await expect(
    page.getByText("Source source-original · revision 2"),
  ).toBeVisible();
});

test("staff without a current organization is directed to choose one", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      status: 403,
      json: { ok: false, error: { code: "FORBIDDEN" } },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          currentOrganizationId: null,
          options: [
            { ...organization, role: "coordinator" },
            {
              ...organization,
              organizationId: "org-2",
              membershipId: "member-2",
              slug: "second",
              name: "Second",
              role: "coordinator",
            },
          ],
        },
      },
    }),
  );
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "Choose an organization" }),
  ).toBeVisible();
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Open workspace" }),
  ).toBeDisabled();
  let selected: unknown;
  await page.route("**/api/auth/organizations/select", (route) => {
    selected = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({ json: { ok: true, value: snapshot } }),
  );
  await page.getByRole("radio", { name: /Second/ }).check();
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect.poll(() => selected).toEqual({ organizationId: "org-2" });
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(
    page.getByRole("heading", { name: "Choose an organization" }),
  ).toHaveCount(0);
  await expect(
    page.getByText("You do not have permission to access this workspace."),
  ).toHaveCount(0);
});

test("user with no organizations sees the not-in-an-organization page", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      status: 403,
      json: { ok: false, error: { code: "FORBIDDEN" } },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({
      json: { ok: true, value: { currentOrganizationId: null, options: [] } },
    }),
  );
  await page.route("**/api/auth/invitations", (route) =>
    route.fulfill({
      json: { ok: true, value: { emailVerified: true, invitations: [] } },
    }),
  );
  await page.route("**/api/auth/sign-out", (route) =>
    route.fulfill({ json: { ok: true } }),
  );
  await page.goto("/workspace");
  await expect(
    page.getByRole("heading", { name: "You're not in an organization yet" }),
  ).toBeVisible();
  await expect(page.getByText("Workspace unavailable")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "verified" })).toHaveAttribute(
    "href",
    "/verify-email",
  );
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("ledger identifies activities and exposes their source without opening correction", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          organization: { ...organization, role: "coordinator" },
          activities: [
            {
              activityId: "a-1",
              kind: "Garden delivery",
              localDate: "2026-01-05",
            },
          ],
          contributions: [
            {
              ...snapshot.contributions[0],
              origin: {
                kind: "source",
                sourceId: "source-original",
                sourceRevision: 2,
              },
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.goto("/workspace/activities");
  await expect(page.getByText("Garden delivery")).toBeVisible();
  await expect(page.getByText("2026-01-05")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Inspect current source evidence" }),
  ).toBeVisible();
  await expect(page.getByText("Corrected minutes")).not.toBeVisible();
});

test("volunteer recognizes and opens their own update evidence", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          sources: [
            {
              sourceId: "own-source",
              revision: 2,
              status: "accepted",
              preview: "Delivered garden supplies",
              receivedAt: "2026-01-05T12:00:00Z",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  await page.route("**/api/product/source?*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          sourceId: "own-source",
          revision: 2,
          channel: "web",
          receivedAt: "2026-01-05T12:00:00Z",
          text: "Delivered garden supplies with the team",
          attachments: [],
        },
      },
    }),
  );
  await page.goto("/workspace/volunteer");
  await expect(
    page.getByText("Delivered garden supplies", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("accepted", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View my update" }).click();
  const evidenceHeading = page.getByRole("heading", {
    name: "Original source evidence",
    exact: true,
  });
  await expect(evidenceHeading).toBeFocused();
  const position = await evidenceHeading.boundingBox();
  expect(position).not.toBeNull();
  expect(position?.y).toBeGreaterThanOrEqual(0);
  expect(position?.y).toBeLessThan(page.viewportSize()?.height ?? 0);
  await expect(
    page.getByText("Delivered garden supplies with the team"),
  ).toBeVisible();
  await expect(
    page.getByText("This is your original update, shown read-only."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Close evidence", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "View my update" }),
  ).toBeFocused();
});

test("switching volunteer updates clears old evidence and errors", async ({
  page,
}) => {
  await page.route("**/api/product/workspace", (route) =>
    route.fulfill({
      json: {
        ok: true,
        value: {
          ...snapshot,
          sources: [
            {
              sourceId: "source-a",
              revision: 1,
              status: "accepted",
              preview: "First update",
            },
            {
              sourceId: "source-b",
              revision: 1,
              status: "accepted",
              preview: "Second update",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/auth/organizations", (route) =>
    route.fulfill({ status: 503, json: { ok: false } }),
  );
  let denyA = false;
  let holdB = true;
  let releaseB: () => void = () => {};
  const delayedB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  await page.route("**/api/product/source?*", async (route) => {
    const id = new URL(route.request().url()).searchParams.get("sourceId");
    if (id === "source-a" && denyA) {
      await route.fulfill({
        status: 403,
        json: { ok: false, error: { code: "FORBIDDEN" } },
      });
      return;
    }
    if (id === "source-b" && holdB) await delayedB;
    await route.fulfill({
      json: {
        ok: true,
        value: {
          sourceId: id,
          revision: 1,
          channel: "web",
          receivedAt: "2026-01-01T00:00:00Z",
          text:
            id === "source-a"
              ? "Private evidence from first update"
              : "Evidence from second update",
          attachments: id === "source-a" ? [{ id: "photo-a" }] : [],
        },
      },
    });
  });
  await page.goto("/workspace/volunteer");
  const updates = page.getByRole("button", { name: "View my update" });
  await updates.nth(0).click();
  await expect(
    page.getByText("Private evidence from first update"),
  ).toBeVisible();
  await expect(
    page.getByAltText("Source attachment photo-a, revision 1"),
  ).toBeVisible();
  await updates.nth(1).click();
  await expect(page.getByText("Source source-b · your update")).toBeVisible();
  await expect(page.getByText("Loading source evidence…")).toBeVisible();
  await expect(
    page.getByText("Private evidence from first update"),
  ).toHaveCount(0);
  await expect(
    page.getByAltText("Source attachment photo-a, revision 1"),
  ).toHaveCount(0);
  holdB = false;
  releaseB();
  await expect(page.getByText("Evidence from second update")).toBeVisible();
  denyA = true;
  await updates.nth(0).click();
  await expect(
    page.getByText("You do not have permission to access this workspace."),
  ).toBeVisible();
  await updates.nth(1).click();
  await expect(page.getByText("Evidence from second update")).toBeVisible();
  await expect(
    page.getByText("You do not have permission to access this workspace."),
  ).toHaveCount(0);
});
