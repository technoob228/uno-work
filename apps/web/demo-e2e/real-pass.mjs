// Loom Work (28.10): a pass against a REAL Work daemon (this branch, run
// locally) with a real Uno account — real Uno Drive, real share link, the
// real `uno.describeVideo` RPC to the gateway. Not part of `run.mjs`.
//
//   REAL_URL=http://localhost:5774/pair#token=… \
//   FAKE_AUDIO=/tmp/speech.wav  STEP=explore|short|long|cleanup \
//   node demo-e2e/real-pass.mjs
//
// The daemon must be the branch's (`node apps/server/src/bin.ts` with
// T3CODE_HOME/UNO_WORK_FILES_ROOT in /tmp and `uno.apiKey` in its
// settings.json) and the web the branch's Vite dev server: `long` imports
// the app's own modules through Vite to read the recording it just made.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SHOTS, dismissBanners, launch, startRecording } from "./harness.mjs";

const url = process.env.REAL_URL;
if (!url) throw new Error("REAL_URL=http://localhost:<web>/pair#token=… is required");
const origin = new URL(url).origin;
const step = process.env.STEP ?? "explore";
const out = join(SHOTS, "real");
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });

const browser = await launch({
  extraArgs: process.env.FAKE_AUDIO
    ? [`--use-file-for-fake-audio-capture=${process.env.FAKE_AUDIO}`]
    : [],
});
// STATE=<file>: the session cookie from the first pairing (pairing tokens are one-time).
const statePath = process.env.STATE;
const { existsSync } = await import("node:fs");
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  ...(statePath && existsSync(statePath) ? { storageState: statePath } : {}),
});
await context.grantPermissions(["camera", "microphone"], { origin });
const page = await context.newPage();
page.on("console", (message) => {
  if (message.type() === "error" || message.type() === "warning")
    console.log(
      `  [console ${new Date().toISOString().slice(11, 19)}]`,
      message.text().slice(0, 300),
    );
});
await page.goto(statePath && existsSync(statePath) ? origin : url, { timeout: 180_000 });
await page.waitForURL((current) => !current.pathname.startsWith("/pair"), { timeout: 60_000 });
if (statePath) await context.storageState({ path: statePath });
await page.waitForLoadState("networkidle").catch(() => undefined);
await dismissBanners(page);

async function items() {
  return page.evaluate(async () => {
    const { useScreenRecordingStore } = await import("/src/screenRecording/recordingStore.ts");
    return Object.values(useScreenRecordingStore.getState().items).map((item) => ({
      id: item.id,
      name: item.name,
      durationMs: item.durationMs,
      sizeBytes: item.sizeBytes,
      parts: item.agentParts.map((part) => ({ bytes: part.blob.size, ms: part.durationMs })),
      save: item.save,
      watch: {
        ...item.watch,
        speech: item.watch.speech.slice(0, 400),
        visual: item.watch.visual.slice(0, 400),
      },
    }));
  });
}

async function waitSettled(timeout = 240_000) {
  const started = Date.now();
  for (;;) {
    const list = await items();
    const item = list.at(-1);
    if (
      item &&
      !["waiting", "running"].includes(item.save.status) &&
      !["waiting", "running"].includes(item.watch.status)
    ) {
      return item;
    }
    if (Date.now() - started > timeout) throw new Error(`not settled: ${JSON.stringify(item)}`);
    await page.waitForTimeout(1000);
  }
}

if (step === "explore") {
  await shot(page, "00-open");
  console.log("url:", page.url());
  console.log(
    "record buttons:",
    await page.getByTestId("record-button").count(),
    "composer:",
    await page.locator('[contenteditable="true"], textarea').count(),
  );
}

if (step === "short" || step === "long") {
  // A chat (the record button lives in the chat composer, not on Home).
  await page
    .getByText(process.env.CHAT ?? "New thread", { exact: true })
    .first()
    .click();
  const seconds = Number(process.env.SECONDS ?? (step === "long" ? 50 : 12));
  await page.getByTestId("record-button").first().waitFor({ timeout: 30_000 });
  await shot(page, `${step}-01-composer`);
  await startRecording(page, { source: "screen", camera: true, microphone: true });
  await page.waitForTimeout(seconds * 1000);
  await shot(page, `${step}-02-recording`);
  await page.getByTestId("recording-stop").click();
  const item = await waitSettled();
  await shot(page, `${step}-03-card`);
  console.log(JSON.stringify(item, null, 2));
  const box = await page
    .locator('[contenteditable="true"], textarea')
    .first()
    .innerText()
    .catch(() => "");
  console.log("composer:", box.slice(0, 600));
  if (step === "long" && process.env.PART2) {
    // The 2nd part (it starts mid-stream) through the real RPC, as one file.
    const result = await page.evaluate(async () => {
      const { useScreenRecordingStore } = await import("/src/screenRecording/recordingStore.ts");
      const item = Object.values(useScreenRecordingStore.getState().items).at(-1);
      const part = item.agentParts[1];
      if (!part) return { error: "no second part" };
      const { realPipelineDeps } = await import("/src/screenRecording/recordingRuntime.ts");
      const deps = realPipelineDeps(item.environmentId);
      const home = await deps.homePath();
      const bytes = new Uint8Array(await part.blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await deps.writeFile({
        cwd: home,
        relativePath: "part-02-check.webm",
        contents: btoa(binary),
        encoding: "base64",
      });
      try {
        const described = await deps.describe({
          path: `${home}/part-02-check.webm`,
          mimeType: "video/webm",
          durationSec: Math.round(part.durationMs / 1000),
        });
        return { bytes: bytes.length, ms: part.durationMs, described };
      } finally {
        await deps.removePaths([`${home}/part-02-check.webm`]).catch(() => undefined);
      }
    });
    console.log("part 2 alone:", JSON.stringify(result, null, 2));
  }
}

if (step === "probe") {
  // A 6 MB file through the same chunked writeFile as Save, timed.
  const result = await page.evaluate(
    async (megabytes) => {
      const { getPrimaryEnvironmentConnection } =
        await import("/src/environments/runtime/service.ts");
      const { realPipelineDeps } = await import("/src/screenRecording/recordingRuntime.ts");
      const { uploadFilesIntoDirectory } = await import("/src/projectUpload.ts");
      const environmentId = getPrimaryEnvironmentConnection().environmentId;
      const deps = realPipelineDeps(environmentId);
      const home = await deps.homePath();
      const bytes = new Uint8Array(megabytes * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i & 255;
      const blob = new Blob([bytes]);
      const started = performance.now();
      const marks = [];
      try {
        const outcome = await uploadFilesIntoDirectory(
          {
            writeFile: async (input) => {
              const t = performance.now();
              const r = await deps.writeFile(input);
              marks.push(Math.round(performance.now() - t));
              return r;
            },
          },
          {
            targetDir: home,
            files: [{ relativePath: "probe.bin", size: blob.size, blob }],
            filterIgnored: false,
          },
        );
        return {
          ok: true,
          outcome,
          ms: Math.round(performance.now() - started),
          marks,
          environmentId,
        };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message ?? error),
          ms: Math.round(performance.now() - started),
          marks,
        };
      } finally {
        await deps.removePaths([`${home}/probe.bin`]).catch(() => undefined);
      }
    },
    Number(process.env.MB ?? 6),
  );
  console.log(JSON.stringify(result));
}

if (step === "list") {
  const listing = await page.evaluate(async (prefix) => {
    const { getPrimaryEnvironmentConnection } =
      await import("/src/environments/runtime/service.ts");
    const env = await import("/src/environmentApi.ts");
    const id = getPrimaryEnvironmentConnection().environmentId;
    const api = env.ensureEnvironmentApi(id);
    const drive = await api.files.driveState();
    const list = await api.files.cloudList({ bucketId: drive.bucketId, prefix });
    return {
      bucketId: drive.bucketId,
      folders: list.folders.map((folder) => folder.prefix),
      objects: list.objects.map((object) => `${object.key} ${object.size}`),
    };
  }, process.env.PREFIX ?? "Recordings/");
  console.log(JSON.stringify(listing, null, 2));
}

if (step === "cleanup") {
  // Deletes what the pass put into Drive: the saved videos named in KEYS.
  const keys = (process.env.KEYS ?? "").split("\n").filter(Boolean);
  const result = await page.evaluate(async (keys) => {
    const { realPipelineDeps } = await import("/src/screenRecording/recordingRuntime.ts");
    const { getPrimaryEnvironmentConnection } =
      await import("/src/environments/runtime/service.ts");
    const deps = realPipelineDeps(getPrimaryEnvironmentConnection().environmentId);
    const drive = await deps.driveState();
    const done = [];
    for (const key of keys) {
      await deps.deleteCloud({ bucketId: drive.bucketId, key });
      done.push(key);
    }
    return done;
  }, keys);
  console.log("deleted:", result);
}

await browser.close();
