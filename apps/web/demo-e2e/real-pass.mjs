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

import { chromium } from "playwright";

import { MEDIA_ARGS, SHOTS, dismissBanners, launch, startRecording } from "./harness.mjs";

const url = process.env.REAL_URL;
if (!url) throw new Error("REAL_URL=http://localhost:<web>/pair#token=… is required");
const origin = new URL(url).origin;
const step = process.env.STEP ?? "explore";
const out = join(SHOTS, "real");
mkdirSync(out, { recursive: true });
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });

const fakeAudio = process.env.FAKE_AUDIO
  ? [`--use-file-for-fake-audio-capture=${process.env.FAKE_AUDIO}`]
  : [];
// CAPTURE_TITLE=<tab title>: share that real tab (Work's own) instead of the
// fake screen — the picture, Work's pointer arrow and click rings are real.
const browser = process.env.CAPTURE_TITLE
  ? await chromium.launch({
      channel: "chrome",
      headless: !process.env.HEADED,
      args: [
        ...MEDIA_ARGS.filter((arg) => !arg.startsWith("--auto-select-desktop-capture-source")),
        `--auto-select-desktop-capture-source=${process.env.CAPTURE_TITLE}`,
        // The tab's real size: an emulated viewport differs from the captured
        // tab, the frame's shape stops matching and Work drops the pointer.
        "--window-size=1440,900",
        ...fakeAudio,
      ],
    })
  : await launch({ extraArgs: fakeAudio });
// STATE=<file>: the session cookie from the first pairing (pairing tokens are one-time).
const statePath = process.env.STATE;
const { existsSync } = await import("node:fs");
const context = await browser.newContext({
  viewport: process.env.CAPTURE_TITLE ? null : { width: 1440, height: 900 },
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

if (step === "home") {
  // Home's "Show the agent": record, Done, the card and the words in Home's
  // box. Stops before Enter (that would start a real agent on this machine).
  await page.getByText("Home", { exact: true }).first().click();
  await page.getByTestId("home-show-agent").waitFor({ timeout: 60_000 });
  await shot(page, "home-01");
  await page.getByTestId("home-show-agent").click();
  await page.getByTestId("record-popup").waitFor();
  await page.getByTestId("record-start").click();
  await page.waitForTimeout(Number(process.env.SECONDS ?? 12) * 1000);
  await shot(page, "home-02-recording");
  await page.getByTestId("recording-stop").click();
  await page.getByTestId("home-recording").waitFor({ timeout: 30_000 });
  const item = await waitSettled();
  await page.waitForTimeout(800);
  await shot(page, "home-03-card");
  console.log(JSON.stringify({ key: (await items()).length, ...item }, null, 2));
  const box = await page
    .locator('[contenteditable="true"], textarea')
    .first()
    .inputValue()
    .catch(async () => page.locator('[contenteditable="true"], textarea').first().innerText());
  console.log("home box:", box.slice(0, 300));
}

if (step === "pointing") {
  // 28.10 «вот тут криво»: Work's own tab is shared; a chip on Home is made
  // crooked; the pointer circles it while the voice (FAKE_AUDIO, 4.0–7.4 s)
  // says «Вот тут криво. Эта кнопка съехала, поправь.»; then the message goes
  // to a new chat and the agent answers. SHIM=http://127.0.0.1:18930 stands
  // in for the gateway's timeline mode (the branch's Go code, not deployed).
  // Newer builds open on Home and have no "Home" item to click.
  if (
    !(await page
      .getByTestId("home-show-agent")
      .isVisible()
      .catch(() => false))
  ) {
    await page.getByText("Home", { exact: true }).first().click();
  }
  await page.getByTestId("home-show-agent").waitFor({ timeout: 60_000 });
  const target = page.getByTestId("home-upload-project");
  await page.addStyleTag({
    content:
      '[data-testid="home-upload-project"]{transform:rotate(7deg) translateY(7px);outline:2px dashed #e11d48}',
  });
  if (process.env.SHIM) {
    await page.evaluate(async (shim) => {
      const runtime = await import("/src/screenRecording/recordingRuntime.ts");
      const store = await import("/src/screenRecording/recordingStore.ts");
      runtime.overrideRecordingDeps((environmentId) => ({
        ...runtime.realPipelineDeps(environmentId),
        describe: async (input) => {
          const item = Object.values(store.useScreenRecordingStore.getState().items).at(-1);
          const part = item.agentParts[0];
          const form = new FormData();
          form.append("file", part.blob, "agent-copy.webm");
          form.append("duration_sec", String(Math.max(1, Math.round(input.durationSec))));
          if (input.mode) form.append("mode", input.mode);
          if (input.events?.length) form.append("events", JSON.stringify(input.events));
          const response = await fetch(`${shim}/video/describe`, { method: "POST", body: form });
          if (!response.ok) throw new Error(`shim ${response.status}: ${await response.text()}`);
          const body = await response.json();
          window.__loomShimAnswer = body;
          return body;
        },
      }));
    }, process.env.SHIM);
  }
  await shot(page, "pointing-01-home-crooked");
  const box = await target.boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(300, 300);
  await page.getByTestId("home-show-agent").click();
  await page.getByTestId("record-popup").waitFor();
  await page.getByTestId("record-source-tab").click();
  const started = Date.now();
  await page.getByTestId("record-start").click();
  await page
    .locator('[data-testid="recording-bar"][data-phase="recording"]')
    .waitFor({ timeout: 15_000 });
  const until = async (ms) => {
    const wait = ms - (Date.now() - started);
    if (wait > 0) await page.waitForTimeout(wait);
  };
  // 0–3 s: the pointer wanders over the page's top.
  await page.mouse.move(700, 160, { steps: 20 });
  await until(2500);
  // 3–8 s: to the chip and around it while «вот тут криво» is said.
  await page.mouse.move(cx, cy, { steps: 25 });
  for (let i = 0; i < 24 && Date.now() - started < 8000; i += 1) {
    const a = (i / 6) * Math.PI;
    await page.mouse.move(cx + Math.cos(a) * box.width * 0.35, cy + Math.sin(a) * 8, { steps: 3 });
    await page.waitForTimeout(120);
  }
  await until(8500);
  // 8.5–12 s: away to the right, still.
  await page.mouse.move(1250, 700, { steps: 20 });
  await until(Number(process.env.SECONDS ?? 13) * 1000);
  await shot(page, "pointing-02-recording");
  await page.getByTestId("recording-stop").click();
  await page.getByTestId("home-recording").waitFor({ timeout: 30_000 });
  const item = await waitSettled();
  const detail = await page.evaluate(async () => {
    const { useScreenRecordingStore } = await import("/src/screenRecording/recordingStore.ts");
    const it = Object.values(useScreenRecordingStore.getState().items).at(-1);
    return {
      name: it.name,
      width: it.width,
      height: it.height,
      events: {
        total: it.events.length,
        clicks: it.events.filter((e) => e.kind === "click").length,
        moves: it.events.filter((e) => e.kind === "move").length,
        scenes: it.events.filter((e) => e.kind === "scene").length,
      },
      live: it.liveFrames.map((f) => `${f.reason}@${f.t}`),
      timeline: it.watch.timeline,
      frames: it.watch.frames.map((f) => ({
        t: f.t,
        reason: f.reason,
        bytes: f.blob.size,
        w: f.width,
      })),
      shim: window.__loomShimAnswer
        ? { cost: window.__loomShimAnswer.cost, model: window.__loomShimAnswer.model }
        : null,
    };
  });
  console.log(
    JSON.stringify(
      {
        save: item.save,
        watchStatus: item.watch.status,
        speech: item.watch.speech,
        visual: item.watch.visual,
        ...detail,
      },
      null,
      2,
    ),
  );
  // The key frames as files, to look at.
  const frameFiles = await page.evaluate(async () => {
    const { useScreenRecordingStore } = await import("/src/screenRecording/recordingStore.ts");
    const it = Object.values(useScreenRecordingStore.getState().items).at(-1);
    const out = [];
    for (const f of it.watch.frames) {
      const bytes = new Uint8Array(await f.blob.arrayBuffer());
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      out.push({ name: `${f.reason}-${f.t}.jpg`, data: btoa(binary) });
    }
    return out;
  });
  for (const file of frameFiles)
    writeFileSync(join(out, `pointing-frame-${file.name}`), Buffer.from(file.data, "base64"));
  await page.waitForTimeout(800);
  await shot(page, "pointing-03-home-card");
  if (process.env.SEND) {
    const homeBox = page.locator('[contenteditable="true"], textarea').first();
    console.log(
      "home box:",
      (await homeBox.inputValue().catch(() => homeBox.innerText())).slice(0, 200),
    );
    await homeBox.click();
    // NOTE=<text>: typed after the transcript (e.g. "only name the place,
    // change nothing" — so the pass checks what the agent understood).
    if (process.env.NOTE) {
      await page.keyboard.press("End");
      await page.keyboard.type(` ${process.env.NOTE}`);
    }
    await page.keyboard.press("Enter");
    await page.getByTestId("recording-message-card").first().waitFor({ timeout: 60_000 });
    await shot(page, "pointing-04-sent");
    const startedAnswer = Date.now();
    let answer = "";
    for (;;) {
      answer = await page.evaluate(() => {
        const rows = [
          ...document.querySelectorAll('[data-message-role="assistant"], [data-role="assistant"]'),
        ];
        return rows.map((row) => row.innerText).join("\n---\n");
      });
      const busy = await page
        .locator('[data-testid="stop-button"], button[aria-label="Stop generation"]')
        .count();
      if (answer.length > 40 && busy === 0) break;
      if (Date.now() - startedAnswer > Number(process.env.ANSWER_TIMEOUT ?? 240_000)) break;
      await page.waitForTimeout(2000);
    }
    await page
      .getByTestId("recording-message-what")
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(500);
    await shot(page, "pointing-05-answer");
    console.log("AGENT ANSWER:\n" + answer.slice(0, 3000));
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
