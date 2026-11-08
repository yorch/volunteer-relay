import { notFound } from "next/navigation";
import { Feedback, PageHeading } from "../../../components/foundation";
import { IntakePreview } from "../../../components/intake-report/preview";
import { VolunteerShell } from "../../../components/layout";

export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <VolunteerShell
      organization="Tidepath · fictional organization"
      mainId="volunteer-main"
    >
      <PageHeading
        title="How did you help today?"
        description="A quick update helps your team see what happened and what comes next."
      />
      <Feedback tone="warning" title="Development preview — no data saved">
        All responses and receipts are simulated. This is not a live submission
        form.
      </Feedback>
      <IntakePreview />
    </VolunteerShell>
  );
}
