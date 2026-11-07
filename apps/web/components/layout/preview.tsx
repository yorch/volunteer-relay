import {
  Badge,
  Button,
  Card,
  EmptyState,
  Feedback,
  Field,
  FileUpload,
  PageHeading,
  Select,
  TextArea,
  TextInput,
} from "../foundation";
import { StaffShell, VolunteerShell } from "./index";
import styles from "./layout.module.css";

/** Development-only visual specimen. No submission, authentication or domain state. */
export function FoundationPreview({
  audience = "staff",
}: {
  audience?: "staff" | "volunteer";
}) {
  const content = (
    <>
      <PageHeading
        title={
          audience === "staff"
            ? "A clearer picture of your community."
            : "How did you help today?"
        }
        description="Visual foundation preview · synthetic examples · no data is saved."
      />
      <div className={audience === "staff" ? styles.previewGrid : styles.stack}>
        <Card title="Share an update">
          <Field
            id="preview-update"
            label="Your update"
            hint="Only share what the team needs to know."
          >
            <TextArea
              id="preview-update"
              aria-describedby="preview-update-hint"
              placeholder="Tell us what happened, in your own words."
            />
          </Field>
          <FileUpload
            id="preview-photo"
            label="Add a photo (optional)"
            hint="Preview only. Files stay in your browser and are not uploaded."
            accept="image/*"
          />
          <p>
            <Button disabled>Submission unavailable in preview</Button>
          </p>
        </Card>
        <div className={styles.stack}>
          <Card title="Clear, honest states">
            <div className={styles.actions}>
              <Badge>Duration unknown</Badge>
              <Badge tone="warning">Provisional alert</Badge>
              <Badge tone="success">Approved</Badge>
              <Badge tone="danger">Needs attention</Badge>
            </div>
            <p>
              Unknown minutes stay unknown. Provisional information is awaiting
              verification.
            </p>
            <Feedback title="Loading example">Checking for updates…</Feedback>
          </Card>
          <Card title="Form patterns">
            <Field id="preview-search" label="Find an update">
              <TextInput id="preview-search" type="search" />
            </Field>
            <Field id="preview-state" label="Display state">
              <Select id="preview-state" defaultValue="unknown">
                <option value="unknown">Unknown</option>
                <option value="pending">Pending review</option>
              </Select>
            </Field>
            <Field
              id="preview-error"
              label="Required detail"
              error="Add a description before continuing."
            >
              <TextInput
                id="preview-error"
                aria-invalid="true"
                aria-describedby="preview-error-error"
              />
            </Field>
            <div className={styles.actions}>
              <Button>Primary action</Button>
              <Button variant="secondary">Secondary action</Button>
              <Button variant="danger">Destructive action</Button>
            </div>
          </Card>
          <Feedback tone="danger" title="Updates could not be loaded">
            Your work has been kept. Try again when the connection returns.
          </Feedback>
          <EmptyState title="No updates to show">
            Change your filters or check back later.
          </EmptyState>
        </div>
      </div>
    </>
  );
  return audience === "volunteer" ? (
    <VolunteerShell
      organization="Tidepath · synthetic organization"
      mainId="preview-main"
    >
      {content}
    </VolunteerShell>
  ) : (
    <StaffShell
      organization="Tidepath · synthetic organization"
      mainId="preview-main"
      currentPath="#preview-main"
      navigation={[
        { href: "#preview-main", label: "Foundation" },
        { href: "#preview-update", label: "Form patterns" },
      ]}
      account="Staff shell specimen"
    >
      {content}
    </StaffShell>
  );
}
