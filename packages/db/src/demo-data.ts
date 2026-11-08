import { createHash } from "node:crypto";
import {
  type ExtractionProposal,
  extractionProposalSchema,
  type SourceEnvelope,
  sourceEnvelopeSchema,
} from "@relay/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./types.ts";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const prefix = "demo-product:v1:";
const id = (name: string) => `${prefix}${name}`;
const fixed = "2026-11-06T12:00:00.000Z";
const marker = id("manifest");
const manifestDigest = createHash("sha256")
  .update("relay-product-demo-profile-v1")
  .digest("hex");
const actor = {
  kind: "user",
  userId: "demo-owner",
  membershipId: "tidepath-demo-owner",
  role: "owner",
};
export const productDemoPhotoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480" viewBox="0 0 720 480"><rect width="720" height="480" fill="#f1eee4"/><rect x="28" y="26" width="664" height="428" rx="18" fill="#fffdf5" stroke="#275850" stroke-width="5"/><text x="360" y="82" text-anchor="middle" font-family="sans-serif" font-size="30" font-weight="bold" fill="#275850">SYNTHETIC DEMO</text><text x="360" y="118" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#52635b">Community supplies — fictional example</text><rect x="100" y="190" width="235" height="175" fill="#d6ab74" stroke="#7f5b3f" stroke-width="5"/><path d="M100 220h235M217 190v175" stroke="#7f5b3f" stroke-width="5"/><rect x="390" y="165" width="110" height="200" rx="12" fill="#7bb5a4" stroke="#275850" stroke-width="5"/><rect x="415" y="135" width="60" height="35" fill="#275850"/><rect x="535" y="220" width="90" height="145" rx="8" fill="#e2c16b" stroke="#8e7231" stroke-width="5"/><text x="360" y="415" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#52635b">Boxes, water and supplies</text></svg>`;
export const productDemoManifest = {
  profileVersion: 1,
  dateWindow: "2026-11-02/2026-11-08",
  tidepath: {
    sources: 10,
    queue: 7,
    approvedMinutes: 180,
    approvedContributions: 3,
    activitiesWithApproved: 2,
    pendingUnknownDuration: 1,
    needs: 5,
  },
  harbor: { sources: 1, approvedMinutes: 0 },
} as const;

/** Inspect only fixture identities; user-edited facts and statuses are never reset. */
export async function inspectDemoProfile(tx: Tx): Promise<"create" | "reuse"> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('relay:product-demo:v1',0))`,
  );
  const roster = await tx.execute(
    sql`select m.organization_id,m.id,m.user_id,m.role,u.email,u.email_verified from member m join "user" u on u.id=m.user_id join account a on a.user_id=u.id and a.id=u.id and a.account_id=u.id and a.provider_id='credential' and a.password is not null and length(a.password)>0 where m.id in ('tidepath-demo-owner','tidepath-demo-coordinator','tidepath-demo-volunteer','tidepath-demo-reader','tidepath-demo-multi','harbor-demo-multi')`,
  );
  const expected = [
    ["tidepath", "tidepath-demo-owner", "demo-owner", "owner"],
    [
      "tidepath",
      "tidepath-demo-coordinator",
      "demo-coordinator",
      "coordinator",
    ],
    ["tidepath", "tidepath-demo-volunteer", "demo-volunteer", "volunteer"],
    ["tidepath", "tidepath-demo-reader", "demo-reader", "report-reader"],
    ["tidepath", "tidepath-demo-multi", "demo-multi", "owner"],
    ["harbor", "harbor-demo-multi", "demo-multi", "report-reader"],
  ];
  if (
    roster.rows.length !== expected.length ||
    expected.some(
      ([org, member, user, role]) =>
        !roster.rows.some(
          (r) =>
            r.organization_id === org &&
            r.id === member &&
            r.user_id === user &&
            r.role === role &&
            r.email === `${user}@example.invalid` &&
            r.email_verified === true,
        ),
    )
  )
    throw new Error("Demo roster is incomplete or changed");
  const organizations = await tx.execute(
    sql`select id,name,slug from organization where id in ('tidepath','harbor')`,
  );
  if (
    !organizations.rows.some(
      (r) =>
        r.id === "tidepath" &&
        r.slug === "tidepath" &&
        r.name === "Tidepath Mutual Aid",
    ) ||
    !organizations.rows.some(
      (r) =>
        r.id === "harbor" &&
        r.slug === "harbor" &&
        r.name === "Harbor Neighbour Network",
    )
  )
    throw new Error("Demo tenants are unavailable");
  const markers = await tx.execute(
    sql`select organization_id,command_type,command_digest,result from domain_command where organization_id in ('tidepath','harbor') and idempotency_key=${marker}`,
  );
  if (markers.rows.length) {
    if (
      markers.rows.length !== 2 ||
      markers.rows.some(
        (r) =>
          r.command_type !== "demo.profile.v1" ||
          r.command_digest !== manifestDigest ||
          JSON.stringify(canonical(r.result)) !==
            JSON.stringify(canonical(productDemoManifest)),
      )
    )
      throw new Error("Demo profile marker conflict");
    const sources = [
      "shared",
      "supplies",
      "recorded-unknown",
      "shared-review",
      "duplicate",
      "correction",
      "spanish",
      "unknown",
      "photo",
      "urgent",
    ];
    for (const name of sources) {
      const rows = await tx.execute(
        sql`select 1 from source s join source_revision r on (r.organization_id,r.source_id,r.revision)=(s.organization_id,s.id,1) join extraction_run x on (x.organization_id,x.source_id,x.source_revision)=(s.organization_id,s.id,1) where s.organization_id='tidepath' and s.id=${id(name)} and x.run_id=${id(`run:${name}`)}`,
      );
      if (!rows.rows.length) throw new Error("Demo profile is incomplete");
    }
    const harbor = await tx.execute(
      sql`select 1 from source s join source_revision r on (r.organization_id,r.source_id,r.revision)=(s.organization_id,s.id,1) join extraction_run x on (x.organization_id,x.source_id,x.source_revision)=(s.organization_id,s.id,1) where s.organization_id='harbor' and s.id=${id("harbor-message")} and x.run_id=${id("run:harbor-message")}`,
    );
    if (!harbor.rows.length) throw new Error("Demo profile is incomplete");
    for (const [table, names] of [
      ["activity", ["shared", "supplies", "unknown"]],
      ["contribution", ["volunteer", "coordinator", "owner", "unknown"]],
      ["need", ["new", "assigned", "acknowledged", "resolved", "urgent"]],
    ] as const) {
      for (const name of names) {
        const rows = await tx.execute(
          sql`select 1 from ${sql.identifier(table)} where organization_id='tidepath' and id=${id(`${table}-${name}`)}`,
        );
        if (!rows.rows.length) throw new Error("Demo profile is incomplete");
      }
    }
    const metadata = await tx.execute(
      sql`select 1 from source_attachment_identity where organization_id='tidepath' and source_id=${id("photo")} and attachment_id=${id("photo-attachment")}`,
    );
    if (!metadata.rows.length) throw new Error("Demo profile is incomplete");
    return "reuse";
  }
  const conflicts = await tx.execute(
    sql`select (select count(*) from source where id like ${`${prefix}%`})+(select count(*) from activity where id like ${`${prefix}%`})+(select count(*) from contribution where id like ${`${prefix}%`})+(select count(*) from need where id like ${`${prefix}%`})+(select count(*) from extraction_run where run_id like ${`${prefix}%`})+(select count(*) from in_app_notification where id like ${`${prefix}%`})+(select count(*) from domain_command where idempotency_key like ${`${prefix}%`})+(select count(*) from organization_settings where organization_id in ('tidepath','harbor')) as count`,
  );
  if (Number(conflicts.rows[0]?.count) !== 0)
    throw new Error("Demo profile collision");
  return "create";
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
function makeSource(
  name: string,
  text: string,
  author: string | null,
  org = "tidepath",
  photo: DemoPhoto | null = null,
): SourceEnvelope {
  const sourceId = id(name);
  const attachment = photo
    ? [{ id: id("photo-attachment"), organizationId: org, ...photo }]
    : [];
  return sourceEnvelopeSchema.parse({
    schemaVersion: 1,
    organizationId: org,
    sourceId,
    revision: 1,
    channel: "web",
    channelIdentity: id(`${org}:web`),
    externalMessageId: sourceId,
    idempotencyKey: id(`intake:${name}`),
    author: {
      externalIdentity: author ?? "Synthetic Harbor participant",
      membershipId: author,
    },
    occurredAt: fixed,
    receivedAt: fixed,
    timezone: org === "tidepath" ? "America/New_York" : "Europe/London",
    text,
    attachments: attachment,
    replyToSourceId: null,
    replacesRevision: null,
    original: { mediaType: "text/plain", payload: text },
  });
}
function ev(source: SourceEnvelope, field: string) {
  return {
    kind: "text" as const,
    field,
    sourceId: source.sourceId,
    sourceRevision: 1,
    start: 0,
    end: source.text.length,
    quote: source.text,
  };
}
type Item = ExtractionProposal["items"][number];
function proposal(
  source: SourceEnvelope,
  items: Item[],
  unresolved: ExtractionProposal["unresolved"] = [],
): ExtractionProposal {
  return extractionProposalSchema.parse({
    schemaVersion: 1,
    organizationId: source.organizationId,
    sourceId: source.sourceId,
    sourceRevision: 1,
    runId: id(`run:${source.sourceId.slice(prefix.length)}`),
    modelVersion: "synthetic-fixture-v1",
    promptVersion: "synthetic-fixture-v1",
    policyVersion: "1",
    items,
    unresolved,
  });
}
function activity(source: SourceEnvelope, key: string, kind = "visit"): Item {
  return {
    kind: "activity",
    key,
    activityKind: kind,
    localDate: "2026-11-06",
    datePrecision: "day",
    beneficiaryReference: source.text.includes("community garden")
      ? "Community garden"
      : source.text.includes("community pantry")
        ? "Community pantry"
        : null,
    evidence: [ev(source, "activityKind")],
  };
}
function contribution(
  source: SourceEnvelope,
  key: string,
  activityKey: string,
  membershipId: string | null,
  durationMinutes: number | null,
): Item {
  return {
    kind: "contribution",
    key,
    activityKey,
    membershipId,
    durationMinutes,
    evidence: [ev(source, "durationMinutes")],
  };
}
function needItem(
  source: SourceEnvelope,
  key: string,
  urgency: "routine" | "urgent",
  summary: string,
): Item {
  return {
    kind: "need",
    key,
    category: "transport",
    urgency,
    summary,
    provisional: urgency === "urgent",
    evidence: [ev(source, "summary")],
  };
}
const volunteer = "tidepath-demo-volunteer",
  coordinator = "tidepath-demo-coordinator",
  owner = "tidepath-demo-owner";
export interface DemoPhoto {
  storageKey: string;
  sha256: string;
  mimeType: "image/png";
  bytes: number;
}
async function insertSource(
  tx: Tx,
  source: SourceEnvelope,
  run: ExtractionProposal,
  status: "review" | "accepted",
) {
  const org = source.organizationId;
  await tx.execute(
    sql`insert into source(organization_id,id) values (${org},${source.sourceId})`,
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical(source)))
    .digest("hex");
  await tx.execute(
    sql`insert into source_revision(organization_id,source_id,revision,channel,channel_identity,external_message_id,idempotency_key,author_external_identity,author_membership_id,occurred_at,received_at,timezone,text_body,original_media_type,original_payload,reply_to_source_id,replaces_revision,canonical_digest,envelope,correlation_id) values (${org},${source.sourceId},1,${source.channel},${source.channelIdentity},${source.externalMessageId},${source.idempotencyKey},${source.author.externalIdentity},${source.author.membershipId},${new Date(fixed)},${new Date(fixed)},${source.timezone},${source.text},'text/plain',${source.original.payload},null,null,${digest},${JSON.stringify(source)}::jsonb,${id("fixture")})`,
  );
  for (const attachment of source.attachments) {
    await tx.execute(
      sql`insert into source_attachment_identity(organization_id,source_id,attachment_id,storage_key,sha256,mime_type,bytes) values (${org},${source.sourceId},${attachment.id},${attachment.storageKey},${attachment.sha256},${attachment.mimeType},${attachment.bytes})`,
    );
    await tx.execute(
      sql`insert into source_attachment(organization_id,source_id,revision,attachment_id) values (${org},${source.sourceId},1,${attachment.id})`,
    );
  }
  await tx.execute(
    sql`insert into processing_policy_snapshot(organization_id,source_id,source_revision,generation,automation_policy,policy_version) values (${org},${source.sourceId},1,1,'review-all','1')`,
  );
  await tx.execute(
    sql`insert into extraction_run(organization_id,run_id,source_id,source_revision,generation,proposal,status,revision,created_at) values (${org},${run.runId},${source.sourceId},1,1,${JSON.stringify(run)}::jsonb,${status},${status === "accepted" ? 2 : 1},${new Date(fixed)})`,
  );
  if (status === "accepted") {
    const command = {
      runId: run.runId,
      expectedRevision: 1,
      idempotencyKey: id(`decision:${source.sourceId}`),
      decision: "accept",
      reason: "Synthetic demo fixture",
    };
    await tx.execute(
      sql`insert into review_decision(organization_id,idempotency_key,run_id,command,outcome,actor,correlation_id,created_at) values (${org},${command.idempotencyKey},${run.runId},${JSON.stringify(command)}::jsonb,'{"revision":2}'::jsonb,${JSON.stringify(actor)}::jsonb,${id("fixture")},${new Date(fixed)})`,
    );
  }
}
async function addAudit(
  tx: Tx,
  type: "activity" | "contribution" | "need",
  aggregateId: string,
  record: unknown,
) {
  await tx.execute(
    sql`insert into domain_audit_event(organization_id,id,aggregate_type,aggregate_id,aggregate_revision,action,actor,correlation_id,reason,before,after,occurred_at) values ('tidepath',${`${type}:${aggregateId}:1`},${type},${aggregateId},1,'created',${JSON.stringify(actor)}::jsonb,${id("fixture")},'Synthetic demo fixture',null,${JSON.stringify(record)}::jsonb,${new Date(fixed)})`,
  );
}
async function addActivity(
  tx: Tx,
  name: string,
  source: SourceEnvelope,
  kind: string,
  beneficiary: string | null,
) {
  const activityId = id(`activity-${name}`);
  const origin = {
    kind: "source",
    sourceId: source.sourceId,
    sourceRevision: 1,
  };
  const record = {
    schemaVersion: 1,
    organizationId: "tidepath",
    activityId,
    revision: 1,
    kind,
    localDate: "2026-11-06",
    datePrecision: "day",
    beneficiaryReference: beneficiary,
    origin,
    createdAt: fixed,
    updatedAt: fixed,
  };
  await tx.execute(
    sql`insert into activity(organization_id,id,revision,kind,local_date,date_precision,beneficiary_reference,origin_kind,origin_source_id,origin_source_revision,created_at,updated_at) values ('tidepath',${activityId},1,${kind},'2026-11-06','day',${beneficiary},'source',${source.sourceId},1,${new Date(fixed)},${new Date(fixed)})`,
  );
  await addAudit(tx, "activity", activityId, record);
  return activityId;
}
async function addContribution(
  tx: Tx,
  name: string,
  activityId: string,
  source: SourceEnvelope,
  membershipId: string,
  minutes: number | null,
) {
  const contributionId = id(`contribution-${name}`),
    status = minutes === null ? "pending" : "approved";
  const origin = {
    kind: "source",
    sourceId: source.sourceId,
    sourceRevision: 1,
  };
  const record = {
    schemaVersion: 1,
    organizationId: "tidepath",
    contributionId,
    activityId,
    revision: 1,
    membershipId,
    durationMinutes: minutes,
    status,
    origin,
    createdAt: fixed,
    updatedAt: fixed,
  };
  await tx.execute(
    sql`insert into contribution(organization_id,id,revision,activity_id,membership_id,duration_minutes,status,origin_kind,origin_source_id,origin_source_revision,created_at,updated_at) values ('tidepath',${contributionId},1,${activityId},${membershipId},${minutes},${status},'source',${source.sourceId},1,${new Date(fixed)},${new Date(fixed)})`,
  );
  await addAudit(tx, "contribution", contributionId, record);
  return contributionId;
}
async function addNeed(
  tx: Tx,
  name: string,
  status: "new" | "assigned" | "acknowledged" | "resolved",
  membershipId: string | null,
  source: SourceEnvelope | null,
) {
  const needId = id(`need-${name}`);
  const assigned = status === "assigned" || status === "acknowledged";
  const acknowledged = status === "acknowledged";
  const resolved = status === "resolved";
  const provisional = name === "urgent";
  const origin = source
    ? { kind: "source" as const, sourceId: source.sourceId, sourceRevision: 1 }
    : { kind: "staff" as const, reason: "Synthetic demo fixture" };
  const summary =
    (
      {
        new: "A neighbor requests a pantry delivery.",
        assigned: "A volunteer driver is needed for a morning pickup.",
        acknowledged: "Deliver a care package to the community center.",
        resolved: "The requested groceries were delivered.",
        urgent: "Urgent: a family needs transport today.",
      } as Record<string, string>
    )[name] ?? "Synthetic need";
  const record = {
    schemaVersion: 1,
    organizationId: "tidepath",
    needId,
    revision: 1,
    category: "transport",
    urgency: provisional ? "urgent" : "routine",
    summary,
    provisional,
    status,
    ownerMembershipId: assigned ? membershipId : null,
    dueAt: null,
    acknowledgeBy: assigned ? "2026-11-08T18:00:00.000Z" : null,
    acknowledgedAt: acknowledged ? "2026-11-07T13:00:00.000Z" : null,
    acknowledgedByMembershipId: acknowledged ? membershipId : null,
    resolvedAt: resolved ? "2026-11-07T15:00:00.000Z" : null,
    resolution: resolved ? "Delivery completed." : null,
    origin,
    createdAt: fixed,
    updatedAt: fixed,
  };
  await tx.execute(
    sql`insert into need(organization_id,id,revision,category,urgency,summary,provisional,status,owner_membership_id,due_at,acknowledge_by,acknowledged_at,acknowledged_by_membership_id,resolved_at,resolution,origin_kind,origin_source_id,origin_source_revision,origin_reason,created_at,updated_at) values ('tidepath',${needId},1,'transport',${record.urgency},${summary},${provisional},${status},${record.ownerMembershipId},null,${record.acknowledgeBy ? new Date(record.acknowledgeBy) : null},${record.acknowledgedAt ? new Date(record.acknowledgedAt) : null},${record.acknowledgedByMembershipId},${record.resolvedAt ? new Date(record.resolvedAt) : null},${record.resolution},${origin.kind},${source?.sourceId ?? null},${source ? 1 : null},${source ? null : "Synthetic demo fixture"},${new Date(fixed)},${new Date(fixed)})`,
  );
  await addAudit(tx, "need", needId, record);
  return needId;
}
async function addEffect(
  tx: Tx,
  runId: string,
  key: string,
  kind: string,
  aggregateId: string,
) {
  await tx.execute(
    sql`insert into review_effect(organization_id,run_id,item_key,kind,aggregate_id,aggregate_revision) values ('tidepath',${runId},${key},${kind},${aggregateId},1)`,
  );
}
/** Inserts synthetic, schema-validated facts without enqueuing delivery or model work. */
export async function insertDemoFixtures(
  tx: Tx,
  photo: DemoPhoto,
): Promise<void> {
  if (
    photo.storageKey !== `${photo.sha256.slice(0, 2)}/${photo.sha256}` ||
    !/^[a-f0-9]{64}$/.test(photo.sha256) ||
    photo.mimeType !== "image/png" ||
    photo.bytes < 1
  )
    throw new Error("Invalid synthetic photo");
  for (const membershipId of [
    volunteer,
    coordinator,
    owner,
    "tidepath-demo-multi",
  ])
    await tx.execute(
      sql`insert into source_author(organization_id,membership_id,current_membership_id) values ('tidepath',${membershipId},${membershipId}) on conflict do nothing`,
    );
  await tx.execute(
    sql`insert into organization_settings(organization_id,revision,timezone,automation_policy,policy_version,routing,fallback_membership_id,ack_minutes,retention_days) values ('tidepath',1,'America/New_York','review-all','1',${JSON.stringify({ transport: [coordinator] })}::jsonb,${owner},60,365),('harbor',1,'Europe/London','review-all','1','{}'::jsonb,null,60,365)`,
  );
  const shared = makeSource(
    "shared",
    "On 2026-11-06 Demo Volunteer and Demo Coordinator each visited the community garden for 60 minutes.",
    volunteer,
  );
  const supplies = makeSource(
    "supplies",
    "On 2026-11-06 I delivered community pantry supplies for 60 minutes.",
    owner,
  );
  const recordedUnknown = makeSource(
    "recorded-unknown",
    "On 2026-11-06 I helped with community pantry supplies, but my time is unknown.",
    volunteer,
  );
  const sharedReview = makeSource(
    "shared-review",
    "On 2026-11-06 Demo Volunteer and Demo Coordinator each planted seedlings for 60 minutes.",
    volunteer,
  );
  const duplicate = makeSource(
    "duplicate",
    "On 2026-11-06 I reported the same community garden visit earlier for 60 minutes.",
    volunteer,
  );
  const correction = makeSource(
    "correction",
    "My earlier garden visit actually took 90 minutes.",
    volunteer,
  );
  const spanish = makeSource(
    "spanish",
    "El 2026-11-06 ayudé a llevar alimentos durante 30 minutos.",
    volunteer,
  );
  const unknown = makeSource(
    "unknown",
    "On 2026-11-06 I helped with community pantry supplies, but forgot the time.",
    volunteer,
  );
  const picture = makeSource(
    "photo",
    "A photo shows donated community supplies.",
    coordinator,
    "tidepath",
    photo,
  );
  const urgent = makeSource(
    "urgent",
    "Urgent: a family needs transport today.",
    volunteer,
  );
  const harbor = makeSource(
    "harbor-message",
    "A synthetic Harbor update awaiting review.",
    null,
    "harbor",
  );
  const runs = [
    {
      s: shared,
      p: proposal(shared, [
        activity(shared, "shared-activity"),
        contribution(
          shared,
          "shared-volunteer",
          "shared-activity",
          volunteer,
          60,
        ),
        contribution(
          shared,
          "shared-coordinator",
          "shared-activity",
          coordinator,
          60,
        ),
      ]),
      status: "accepted" as const,
    },
    {
      s: supplies,
      p: proposal(supplies, [
        activity(supplies, "supplies-activity", "supplies"),
        contribution(
          supplies,
          "supplies-owner",
          "supplies-activity",
          owner,
          60,
        ),
      ]),
      status: "accepted" as const,
    },
    {
      s: recordedUnknown,
      p: proposal(recordedUnknown, [
        activity(recordedUnknown, "unknown-activity", "supplies"),
        contribution(
          recordedUnknown,
          "unknown-volunteer",
          "unknown-activity",
          volunteer,
          null,
        ),
      ]),
      status: "accepted" as const,
    },
    {
      s: sharedReview,
      p: proposal(sharedReview, [
        activity(sharedReview, "review-activity"),
        contribution(
          sharedReview,
          "review-volunteer",
          "review-activity",
          volunteer,
          60,
        ),
        contribution(
          sharedReview,
          "review-coordinator",
          "review-activity",
          coordinator,
          60,
        ),
      ]),
      status: "review" as const,
    },
    {
      s: duplicate,
      p: proposal(
        duplicate,
        [
          activity(duplicate, "duplicate-activity"),
          contribution(
            duplicate,
            "duplicate-volunteer",
            "duplicate-activity",
            volunteer,
            60,
          ),
        ],
        [
          {
            field: "duplicateCandidate",
            reason: "Synthetic possible duplicate for staff review",
          },
        ],
      ),
      status: "review" as const,
    },
    {
      s: correction,
      p: proposal(correction, [
        {
          kind: "correction",
          key: "correction-item",
          targetId: id("contribution-volunteer"),
          expectedRevision: 1,
          durationMinutes: 90,
          reason: "Synthetic correction requires staff review",
          evidence: [ev(correction, "durationMinutes")],
        },
      ]),
      status: "review" as const,
    },
    {
      s: spanish,
      p: proposal(spanish, [
        activity(spanish, "spanish-activity", "supplies"),
        contribution(
          spanish,
          "spanish-volunteer",
          "spanish-activity",
          volunteer,
          30,
        ),
      ]),
      status: "review" as const,
    },
    {
      s: unknown,
      p: proposal(
        unknown,
        [
          activity(unknown, "unknown-review-activity", "supplies"),
          contribution(
            unknown,
            "unknown-review-volunteer",
            "unknown-review-activity",
            volunteer,
            null,
          ),
        ],
        [{ field: "durationMinutes", reason: "Duration is not stated" }],
      ),
      status: "review" as const,
    },
    {
      s: picture,
      p: proposal(picture, [
        {
          kind: "need",
          key: "photo-need",
          category: "supplies",
          urgency: "routine",
          summary: "Review the fictional donated supplies photo.",
          provisional: false,
          evidence: [
            {
              kind: "attachment",
              field: "summary",
              sourceId: picture.sourceId,
              sourceRevision: 1,
              attachmentId: id("photo-attachment"),
              observation:
                "Illustration labeled SYNTHETIC DEMO showing boxes and supplies.",
            },
          ],
        },
      ]),
      status: "review" as const,
    },
    {
      s: urgent,
      p: proposal(urgent, [
        needItem(
          urgent,
          "urgent-need",
          "urgent",
          "Urgent: a family needs transport today.",
        ),
      ]),
      status: "review" as const,
    },
    {
      s: harbor,
      p: proposal(
        harbor,
        [],
        [
          {
            field: "activity",
            reason: "Synthetic Harbor item awaits staff review",
          },
        ],
      ),
      status: "review" as const,
    },
  ];
  for (const run of runs) await insertSource(tx, run.s, run.p, run.status);
  const sharedId = await addActivity(
    tx,
    "shared",
    shared,
    "visit",
    "Community garden",
  );
  const suppliesId = await addActivity(
    tx,
    "supplies",
    supplies,
    "supplies",
    "Community pantry",
  );
  const unknownId = await addActivity(
    tx,
    "unknown",
    recordedUnknown,
    "supplies",
    "Community pantry",
  );
  const c1 = await addContribution(
    tx,
    "volunteer",
    sharedId,
    shared,
    volunteer,
    60,
  );
  const c2 = await addContribution(
    tx,
    "coordinator",
    sharedId,
    shared,
    coordinator,
    60,
  );
  const c3 = await addContribution(
    tx,
    "owner",
    suppliesId,
    supplies,
    owner,
    60,
  );
  const c4 = await addContribution(
    tx,
    "unknown",
    unknownId,
    recordedUnknown,
    volunteer,
    null,
  );
  await addEffect(
    tx,
    id("run:shared"),
    "shared-activity",
    "activity",
    sharedId,
  );
  await addEffect(tx, id("run:shared"), "shared-volunteer", "contribution", c1);
  await addEffect(
    tx,
    id("run:shared"),
    "shared-coordinator",
    "contribution",
    c2,
  );
  await addEffect(
    tx,
    id("run:supplies"),
    "supplies-activity",
    "activity",
    suppliesId,
  );
  await addEffect(tx, id("run:supplies"), "supplies-owner", "contribution", c3);
  await addEffect(
    tx,
    id("run:recorded-unknown"),
    "unknown-activity",
    "activity",
    unknownId,
  );
  await addEffect(
    tx,
    id("run:recorded-unknown"),
    "unknown-volunteer",
    "contribution",
    c4,
  );
  await addNeed(tx, "new", "new", null, null);
  const assigned = await addNeed(tx, "assigned", "assigned", coordinator, null);
  await addNeed(tx, "acknowledged", "acknowledged", owner, null);
  await addNeed(tx, "resolved", "resolved", null, null);
  const urgentNeed = await addNeed(tx, "urgent", "new", null, urgent);
  await tx.execute(
    sql`insert into provisional_need(organization_id,run_id,item_key_hash,need_id) values ('tidepath',${id("run:urgent")},${createHash("sha256").update("urgent-need").digest("hex")},${urgentNeed})`,
  );
  await tx.execute(
    sql`insert into in_app_notification(organization_id,id,recipient_id,revision,type,need_id,title,app_path,dedupe_key,created_at,read_at) values ('tidepath',${id("notification-owner")},${owner},1,'need-overdue',${urgentNeed},'Synthetic demo: urgent transport needs review','/workspace/needs',${id("notice-owner")},${new Date(fixed)},null),('tidepath',${id("notification-coordinator")},${coordinator},1,'need-assigned',${assigned},'Synthetic demo: a delivery is assigned','/workspace/needs',${id("notice-coordinator")},${new Date(fixed)},${new Date(fixed)})`,
  );
  await tx.execute(
    sql`insert into delivery_job(organization_id,id,recipient_id,channel,delivery_key,template,app_path,need_id,need_revision,attempts,created_at) values ('tidepath',${id("delivery-failed")},${coordinator},'email',${id("delivery-key")},'need-assigned','/workspace/needs',${assigned},1,3,${new Date(fixed)})`,
  );
  await tx.execute(
    sql`insert into delivery_attempt(organization_id,job_id,attempt,accepted,provider_id,occurred_at) values ('tidepath',${id("delivery-failed")},3,false,null,${new Date(fixed)})`,
  );
  for (const org of ["tidepath", "harbor"])
    await tx.execute(
      sql`insert into domain_command(organization_id,idempotency_key,command_type,command_digest,result,correlation_id) values (${org},${marker},'demo.profile.v1',${manifestDigest},${JSON.stringify(productDemoManifest)}::jsonb,${id("fixture")})`,
    );
}
