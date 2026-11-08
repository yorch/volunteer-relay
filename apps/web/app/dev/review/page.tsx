import { notFound } from "next/navigation";
import { Feedback, PageHeading } from "../../../components/foundation";
import { StaffShell } from "../../../components/layout";
import {
  memberLabels,
  reviewFixtures,
} from "../../../components/review/fixtures";
import { ReviewPreview } from "../../../components/review/preview";
export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <StaffShell
      organization="Tidepath · fictional organization"
      mainId="inbox-main"
      currentPath="/workspace/inbox"
      navigation={[
        { href: "/workspace/inbox", icon: "inbox", label: "Source inbox" },
      ]}
      account="Staff preview only"
    >
      <PageHeading
        title="Every update has a story."
        description="Keep original evidence in view as you review what it may mean."
      />
      <Feedback tone="warning" title="Development preview — no data saved">
        Synthetic sources and independently authored candidates. Decisions are
        simulated; no ledger, alerts or assignments change.
      </Feedback>
      <ReviewPreview entries={reviewFixtures} memberLabels={memberLabels} />
    </StaffShell>
  );
}
