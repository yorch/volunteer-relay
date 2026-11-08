"use client";

import type {
  Receipt,
  SourceEnvelope,
  WorkspaceSnapshot,
} from "@relay/contracts";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { errorMessage, request } from "../api-client";
import { Card as BaseCard, Live } from "../card";
import {
  Badge,
  Button,
  Field,
  Icon,
  Select,
  TextArea,
  TextInput,
} from "../foundation";
import styles from "./import.module.css";
import { key } from "./shared";

function Card({ children }: { children: ReactNode }) {
  return <BaseCard className={styles.card}>{children}</BaseCard>;
}
type ImportDraft = {
  format: "json" | "csv" | "whatsapp";
  text: string;
  dateFormat: "ISO" | "YYYY-MM-DD" | "MM/DD/YYYY" | "DD/MM/YYYY";
  timezone: string;
  authorMapping: Record<string, string | null>;
  photoMapping?: Record<string, string[]>;
};
type ImportPreview = {
  sources: SourceEnvelope[];
  errors: Array<{ row: number; code: string; message: string }>;
  ambiguousDuplicates: Array<{ sourceIds: string[]; rows: number[] }>;
};
function importRequest<T>(path: string, data: object, files: File[]) {
  if (!files.length) return request<T>(path, data);
  const form = new FormData();
  form.set("data", JSON.stringify(data));
  for (const file of files) form.append("files", file, file.name);
  return request<T>(path, form);
}
export function Import({ members }: { members: WorkspaceSnapshot["members"] }) {
  const [format, setFormat] = useState<ImportDraft["format"]>("csv");
  const [text, setText] = useState("");
  const [dateFormat, setDateFormat] =
    useState<ImportDraft["dateFormat"]>("ISO");
  const [timezone, setTimezone] = useState("UTC");
  const [authorRows, setAuthorRows] = useState<
    Array<{ rowId: string; author: string; member: string }>
  >([]);
  const [photoRows, setPhotoRows] = useState<
    Array<{ rowId: string; id: string; filenames: string }>
  >([]);
  const [files, setFiles] = useState<File[]>([]);
  const [reading, setReading] = useState(false);
  const [textName, setTextName] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  const [receipts, setReceipts] = useState<Receipt[] | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<string | null>(null);
  function invalidate() {
    setPreview(null);
    setDraft(null);
    setAck(false);
    setReceipts(null);
    attempt.current = null;
  }
  async function previewImport(e: FormEvent) {
    e.preventDefault();
    const authorMapping: Record<string, string | null> = Object.create(null);
    for (const row of authorRows) {
      if (!row.author.trim()) {
        setError("Enter a name for each author mapping.");
        return;
      }
      if (Object.hasOwn(authorMapping, row.author.trim())) {
        setError(
          "Each author name can be matched only once. Remove the duplicate match.",
        );
        return;
      }
      authorMapping[row.author.trim()] = row.member || null;
    }
    const photoMapping: Record<string, string[]> = Object.create(null);
    for (const row of photoRows) {
      if (!row.id.trim() || !row.filenames) {
        setError("Enter an update ID and select a photo for each link.");
        return;
      }
      const id = row.id.trim();
      photoMapping[id] = [...(photoMapping[id] ?? []), row.filenames];
    }
    if (
      files.length > 10 ||
      files.some(
        (file) =>
          file.size > 10 * 1024 * 1024 ||
          !["image/png", "image/jpeg", "image/webp"].includes(file.type),
      ) ||
      new Set(files.map((file) => file.name)).size !== files.length
    ) {
      setError(
        "Choose up to 10 PNG, JPEG or WebP photos, each up to 10 MB, with unique filenames.",
      );
      return;
    }
    const next: ImportDraft = {
      format,
      text,
      dateFormat,
      timezone,
      authorMapping,
      ...(Object.keys(photoMapping).length ? { photoMapping } : {}),
    };
    setPending(true);
    setError("");
    const result = await importRequest<ImportPreview>(
      "/api/product/import-preview",
      next,
      files,
    );
    if (result.ok) {
      setDraft(next);
      setPreview(result.value);
      setAck(false);
      attempt.current = null;
    } else setError(errorMessage(result.error.code));
    setPending(false);
  }
  async function confirm() {
    if (
      !preview ||
      !draft ||
      preview.errors.length ||
      (preview.ambiguousDuplicates.length && !ack)
    )
      return;
    attempt.current ??= key();
    setPending(true);
    setError("");
    const result = await importRequest<{ receipts: Receipt[] }>(
      "/api/product/import",
      {
        ...draft,
        idempotencyKey: attempt.current,
        ...(ack ? { allowAmbiguous: true } : {}),
      },
      files,
    );
    if (result.ok) {
      setReceipts(result.value.receipts);
      setPreview(null);
      setDraft(null);
      attempt.current = null;
    } else setError(errorMessage(result.error.code));
    setPending(false);
  }
  const stage = receipts ? 3 : preview ? 2 : 1;
  const steps = ["Prepare your file", "Preview and check", "Confirm import"];
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.eyebrow}>Bring updates together</span>
        <h1>Import updates</h1>
        <p>
          Preview rows and author mappings before submitting. Possible
          duplicates are preserved for review.
        </p>
        <ol className={styles.steps}>
          {steps.map((label, index) => (
            <li
              key={label}
              data-state={
                index + 1 < stage
                  ? "done"
                  : index + 1 === stage
                    ? "current"
                    : "next"
              }
              {...(index + 1 === stage ? { "aria-current": "step" } : {})}
            >
              <span className={styles.stepMark} aria-hidden="true">
                {index + 1 < stage ? (
                  <Icon name="check" size={16} />
                ) : (
                  index + 1
                )}
              </span>
              {label}
            </li>
          ))}
        </ol>
      </header>
      <Card>
        <form
          className={styles.form}
          onSubmit={previewImport}
          onChange={invalidate}
        >
          <div className={styles.importGrid}>
            <Field id="import-format" label="Format">
              <Select
                id="import-format"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as ImportDraft["format"]);
                  invalidate();
                }}
              >
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="whatsapp">WhatsApp</option>
              </Select>
            </Field>
            <Field id="import-date-format" label="Date format">
              <Select
                id="import-date-format"
                value={dateFormat}
                onChange={(e) => {
                  setDateFormat(e.target.value as ImportDraft["dateFormat"]);
                  invalidate();
                }}
              >
                <option>ISO</option>
                <option>YYYY-MM-DD</option>
                <option>MM/DD/YYYY</option>
                <option>DD/MM/YYYY</option>
              </Select>
            </Field>
            <div className={styles.fieldGroup}>
              <label htmlFor="import-file">
                Text file (JSON, CSV or TXT, up to 5 MB)
              </label>
              <div className={styles.dropzone}>
                <span className={styles.dropzoneIcon} aria-hidden="true">
                  <Icon name="upload" size={20} />
                </span>
                <span className={styles.dropzoneText}>
                  <strong>{textName || "Choose a file"}</strong>
                  {!textName && (
                    <span aria-hidden="true">Drop it here or browse</span>
                  )}
                </span>
                <input
                  id="import-file"
                  type="file"
                  accept=".json,.csv,.txt,application/json,text/csv,text/plain"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (
                      file.size > 5 * 1024 * 1024 ||
                      !/\.(json|csv|txt)$/i.test(file.name)
                    ) {
                      setError("Choose a JSON, CSV or TXT file up to 5 MB.");
                      return;
                    }
                    setReading(true);
                    try {
                      setText(await file.text());
                      setTextName(file.name);
                      setError("");
                    } catch {
                      setError("Could not read the selected file.");
                    } finally {
                      setReading(false);
                    }
                  }}
                />
              </div>
            </div>
            <div className={styles.fieldGroup}>
              <label htmlFor="import-photos">
                Photos (up to 10 PNG, JPEG or WebP files, each up to 10 MB)
              </label>
              <div className={styles.dropzone}>
                <span className={styles.dropzoneIcon} aria-hidden="true">
                  <Icon name="camera" size={20} />
                </span>
                <span className={styles.dropzoneText}>
                  <strong>
                    {files.length
                      ? `${files.length} selected`
                      : "Choose photos"}
                  </strong>
                  <span aria-hidden={files.length ? undefined : "true"}>
                    {files.length
                      ? files.map((f) => f.name).join(", ")
                      : "Drop them here or browse"}
                  </span>
                </span>
                <input
                  id="import-photos"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
                />
              </div>
            </div>
            <div className={styles.wide}>
              <Field id="import-text" label="Import text">
                <TextArea
                  id="import-text"
                  required
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                />
              </Field>
            </div>
            <Field id="import-timezone" label="Timezone">
              <TextInput
                id="import-timezone"
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </Field>
          </div>
          <h2>Match authors and photos</h2>
          <fieldset className={styles.mapping}>
            <legend>Link photos to updates</legend>
            <p>
              Match an update ID from your file to the filenames you selected
              above.
            </p>
            {photoRows.map((row, index) => (
              <div className={styles.mappingRow} key={row.rowId}>
                <Field id={`photo-id-${row.rowId}`} label="Update ID">
                  <TextInput
                    id={`photo-id-${row.rowId}`}
                    value={row.id}
                    onChange={(e) =>
                      setPhotoRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, id: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </Field>
                <Field id={`photo-file-${row.rowId}`} label="Photo">
                  <Select
                    id={`photo-file-${row.rowId}`}
                    value={row.filenames}
                    onChange={(e) => {
                      const value = e.target.value;
                      invalidate();
                      setPhotoRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, filenames: value } : r,
                        ),
                      );
                    }}
                  >
                    <option value="">Select a photo</option>
                    {files.map((file) => (
                      <option key={file.name} value={file.name}>
                        {file.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPhotoRows((rows) => rows.filter((_, i) => i !== index));
                    invalidate();
                  }}
                >
                  Remove photo link
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  invalidate();
                  setPhotoRows((rows) => [
                    ...rows,
                    { rowId: key(), id: "", filenames: "" },
                  ]);
                }}
              >
                Add photo link
              </Button>
            </div>
          </fieldset>
          <fieldset className={styles.mapping}>
            <legend>Match authors to volunteers</legend>
            <p>
              Optionally connect names in the file to members of your team.
              Leave a volunteer unknown when unsure.
            </p>
            {authorRows.map((row, index) => (
              <div className={styles.mappingRow} key={row.rowId}>
                <Field id={`author-name-${row.rowId}`} label="Author name">
                  <TextInput
                    id={`author-name-${row.rowId}`}
                    value={row.author}
                    onChange={(e) =>
                      setAuthorRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, author: e.target.value } : r,
                        ),
                      )
                    }
                  />
                </Field>
                <Field id={`author-member-${row.rowId}`} label="Volunteer">
                  <Select
                    id={`author-member-${row.rowId}`}
                    value={row.member}
                    onChange={(e) => {
                      const value = e.target.value;
                      invalidate();
                      setAuthorRows((rows) =>
                        rows.map((r, i) =>
                          i === index ? { ...r, member: value } : r,
                        ),
                      );
                    }}
                  >
                    <option value="">Unknown</option>
                    {members.map((m) => (
                      <option key={m.membershipId} value={m.membershipId}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAuthorRows((rows) => rows.filter((_, i) => i !== index));
                    invalidate();
                  }}
                >
                  Remove author match
                </Button>
              </div>
            ))}
            <div>
              <Button
                variant="secondary"
                onClick={() => {
                  invalidate();
                  setAuthorRows((rows) => [
                    ...rows,
                    { rowId: key(), author: "", member: "" },
                  ]);
                }}
              >
                Add author match
              </Button>
            </div>
          </fieldset>
          <p className={styles.hint}>
            Default fields: id, author, text, timestamp.
          </p>
          <div className={styles.actions}>
            <Button type="submit" disabled={pending || reading}>
              Preview import
            </Button>
          </div>
        </form>
      </Card>
      <Live kind="alert" className={styles.error}>
        {error}
      </Live>
      {preview && (
        <Card>
          <h2>Preview</h2>
          <p>{preview.sources.length} sources ready to review.</p>
          <div className={styles.tableScroll}>
            <table className={styles.table} aria-label="Import rows">
              <thead>
                <tr>
                  <th scope="col">Author</th>
                  <th scope="col">Update</th>
                  <th scope="col" className={styles.num}>
                    Attachments
                  </th>
                </tr>
              </thead>
              <tbody>
                {preview.sources.map((source) => (
                  <tr key={`${source.sourceId}-${source.revision}`}>
                    <td>{source.author.externalIdentity}</td>
                    <td>{source.text}</td>
                    <td className={styles.num}>
                      {source.attachments.length} attachments
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.errors.length > 0 && (
            <div className={styles.issues}>
              <h3>Errors</h3>
              <ul>
                {preview.errors.map((e) => (
                  <li key={`${e.row}:${e.code}`} className={styles.issueError}>
                    <Badge tone="danger">
                      <Icon name="alert" size={16} /> Error
                    </Badge>
                    <span>
                      Row {e.row}: {e.message} ({e.code})
                    </span>
                  </li>
                ))}
              </ul>
              <p>Fix errors before confirming.</p>
            </div>
          )}
          {preview.ambiguousDuplicates.length > 0 && (
            <div className={styles.issues}>
              <h3>Possible duplicates</h3>
              <ul>
                {preview.ambiguousDuplicates.map((d) => (
                  <li
                    key={`${d.rows.join(",")}:${d.sourceIds.join(",")}`}
                    className={styles.issueWarn}
                  >
                    <Badge tone="warning">
                      <Icon name="flag" size={16} /> Duplicate
                    </Badge>
                    <span>
                      Rows {d.rows.join(", ")} · sources{" "}
                      {d.sourceIds.join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
              <label className={styles.ack}>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => {
                    setAck(e.target.checked);
                    attempt.current = null;
                  }}
                />
                <span>Preserve possible duplicates for review</span>
              </label>
            </div>
          )}
          <div className={styles.actions}>
            <Button
              disabled={
                pending ||
                preview.errors.length > 0 ||
                (preview.ambiguousDuplicates.length > 0 && !ack)
              }
              onClick={() => void confirm()}
            >
              Confirm import
            </Button>
          </div>
        </Card>
      )}
      {receipts && (
        <Card>
          <h2>Import received</h2>
          <p>{receipts.length} updates received.</p>
          <ul className={styles.receiptList}>
            {receipts.map((r) => (
              <li key={`${r.sourceId}-${r.revision}`}>
                <Icon name="check" size={16} />
                <span>
                  {r.sourceId} · revision {r.revision}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
