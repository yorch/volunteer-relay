import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { BrowserContext, Page } from "@playwright/test";
import {
  defaultEvidenceLimits,
  type EvidenceCaptureInput,
  type EvidenceStore,
} from "./contract.ts";

// Callers supply synthetic, non-sensitive browser states. Text redaction cannot
// protect pixels/video. No helper navigates, starts tracing, or records a desktop.
export async function captureScreenshot(
  page: Page,
  store: EvidenceStore,
  runId: string,
  input: Omit<EvidenceCaptureInput, "mime">,
) {
  const bytes = await page.screenshot({ type: "png", timeout: 10_000 });
  return store.append(runId, { ...input, mime: "image/png" }, bytes);
}

// The caller must explicitly configure recordVideo on its private context. This
// helper creates and owns closing a fresh scenario page, including on timeout, to bound capture.
export async function captureScenarioVideo(
  context: BrowserContext,
  store: EvidenceStore,
  runId: string,
  input: Omit<EvidenceCaptureInput, "mime">,
  options: {
    enabled: true;
    maxDurationMs: number;
    scenario: (page: Page) => Promise<void>;
  },
) {
  if (
    options.enabled !== true ||
    !Number.isInteger(options.maxDurationMs) ||
    options.maxDurationMs < 1 ||
    options.maxDurationMs > 30_000
  )
    throw new Error("Evidence video options rejected");
  const page = await context.newPage();
  const video = page.video();
  if (!video) {
    await page.close();
    throw new Error("Evidence video requires explicit context recording");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false;
  try {
    await Promise.race([
      options.scenario(page),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Evidence scenario deadline")),
          options.maxDurationMs,
        );
      }),
    ]);
  } catch {
    failed = true;
  } finally {
    if (timer) clearTimeout(timer);
    await page.close();
  }
  const path = await video.path();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > defaultEvidenceLimits.maxArtifactBytes)
      throw new Error("Evidence video size rejected");
    const bytes = await file.readFile();
    return await store.append(
      runId,
      {
        ...input,
        mime: "video/webm",
        outcome: failed ? "finding" : input.outcome,
      },
      bytes,
    );
  } finally {
    await file.close();
    await video.delete();
  }
}
