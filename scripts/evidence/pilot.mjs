// Synthetic-only local pilot. Text redaction does not protect screenshot/video
// pixels. No credentials, private source, traces, uploads or external navigation.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { captureScenarioVideo, captureScreenshot } from "./capture.ts";
import { createEvidenceStore } from "./store.ts";

if (process.versions.node !== "26.11.1") throw Error("Requires Node 26.11.1");
const base = resolve(".relay-local/evidence-pilot");
mkdirSync(base, { recursive: true, mode: 0o700 });
const root = realpathSync(base);
const store = await createEvidenceStore(resolve(root, "store"));
const testedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const run = await store.createRun({ task: "P0-20", lane: "F", testedCommit });
const server = createServer((req, res) => {
  if (req.url !== "/qa-synthetic") {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Cache-Control", "no-store");
  res.end(
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic evidence pilot</title><style>body{font:24px system-ui;background:#eff6ff;color:#172554;padding:40px}button{font:inherit;padding:16px}</style><h1>Synthetic evidence pilot</h1><p id="state">Ready for controlled interaction</p><button onclick="document.getElementById(\'state\').textContent=\'Synthetic action complete\'">Complete synthetic action</button></html>',
  );
});
let browser;
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(3193, "127.0.0.1", resolve);
  });
  browser = await chromium.launch({ headless: true });
  const viewport = { width: 800, height: 600 };
  const context = await browser.newContext({
    viewport,
    recordVideo: { dir: resolve(root, "temporary-video"), size: viewport },
  });
  const screenshotContext = await browser.newContext({ viewport });
  const page = await screenshotContext.newPage();
  await page.goto("http://127.0.0.1:3193/qa-synthetic");
  const input = {
    route: "/qa-synthetic",
    scenario: "initial",
    step: 0,
    browser: "chromium",
    viewport,
    outcome: "captured",
    findingIds: [],
    recheckOf: null,
  };
  const screenshot = await captureScreenshot(page, store, run.runId, input);
  const video = await captureScenarioVideo(
    context,
    store,
    run.runId,
    { ...input, scenario: "interaction", step: 1 },
    {
      enabled: true,
      maxDurationMs: 3000,
      scenario: async (page) => {
        await page.goto("http://127.0.0.1:3193/qa-synthetic");
        await page.getByRole("button").click();
        await page.getByText("Synthetic action complete").waitFor();
        await page.waitForTimeout(400);
      },
    },
  );
  await screenshotContext.close();
  await context.close();
  const reopened = await createEvidenceStore(resolve(root, "store"));
  for (const a of [screenshot, video]) {
    const read = await reopened.read(a.artifactId);
    if (
      !read ||
      createHash("sha256").update(read.content).digest("hex") !== a.sha256
    )
      throw Error("Pilot integrity failed");
  }
  // Browser decoding checks actual screenshot and video bytes, without a gallery.
  const inspect = await browser.newPage();
  const png = await reopened.read(screenshot.artifactId);
  const webm = await reopened.read(video.artifactId);
  await inspect.setContent(
    '<img alt="Captured synthetic screenshot"><video muted controls></video>',
  );
  const dimensions = await inspect.evaluate(
    async ({ png, webm }) => {
      const image = document.querySelector("img");
      const video = document.querySelector("video");
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      video.src = `data:video/webm;base64,${webm}`;
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = reject;
      });
      return {
        image: [image.naturalWidth, image.naturalHeight],
        video: [video.videoWidth, video.videoHeight],
        duration: video.duration,
      };
    },
    {
      png: Buffer.from(png.content).toString("base64"),
      webm: Buffer.from(webm.content).toString("base64"),
    },
  );
  console.log(
    JSON.stringify({
      runId: run.runId,
      artifacts: [screenshot.artifactId, video.artifactId],
      dimensions,
      manifestArtifacts: (await reopened.manifest(run.runId)).artifacts.length,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
