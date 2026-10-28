// The background-tab check without Playwright (it keeps every page "visible"
// and turns Chrome's throttling off): real Chrome over raw CDP, a real second
// tab in front for 5 s while Work records with the camera circle, then the
// recording's frames are counted. `node demo-e2e/background-raw.mjs`
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MEDIA_ARGS, serve } from "./harness.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// DEMO_URL=https://… DEMO_PASSWORD=… runs it on the published site.
const server = process.env.DEMO_URL
  ? { url: process.env.DEMO_URL.replace(/\/?$/, "/"), close: () => undefined }
  : await serve();
const profile = mkdtempSync(join(tmpdir(), "loom-bg-"));
const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [
  ...MEDIA_ARGS,
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=1440,900",
  process.env.DEMO_URL ? server.url : `${server.url}?loom=normal&speed=4&panel=closed`,
]);
let id = 0;
const pending = new Map();
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
}
try {
  let targets = [];
  for (
    let i = 0;
    i < 50 && !targets.some((t) => t.type === "page" && t.url.startsWith(server.url));
    i++
  ) {
    await sleep(300);
    targets = await fetch(`http://127.0.0.1:${port}/json`)
      .then((r) => r.json())
      .catch(() => []);
  }
  const page = targets.find((t) => t.type === "page" && t.url.startsWith(server.url));
  const send = await connect(page.webSocketDebuggerUrl);
  const run = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      userGesture: true,
      returnByValue: true,
    });
    if (result.result?.exceptionDetails)
      throw new Error(JSON.stringify(result.result.exceptionDetails).slice(0, 400));
    return result.result?.result?.value;
  };
  const until = async (expression, timeout = 30000) => {
    const start = Date.now();
    while (!(await run(expression))) {
      if (Date.now() - start > timeout) throw new Error(`timeout: ${expression}`);
      await sleep(200);
    }
  };
  const click = (testId) => run(`document.querySelector('[data-testid="${testId}"]').click()`);
  if (process.env.DEMO_PASSWORD) {
    await until(`!!document.querySelector('input[name="password"]') || !!window.__loomDemo`);
    await run(
      `(() => { const i = document.querySelector('input[name="password"]'); if (i) { i.value = ${JSON.stringify(process.env.DEMO_PASSWORD)}; i.form.submit(); } })()`,
    );
    await sleep(2500);
    await run(
      `location.href = ${JSON.stringify(server.url + "?loom=normal&speed=4&panel=closed")}`,
    );
    await sleep(1500);
  }
  await until(
    `Boolean(window.__loomDemo) && !!document.querySelector('[data-testid="loom-panel-pill"]')`,
  );
  await click("loom-panel-pill");
  await until(`!!document.querySelector('[data-testid="loom-open-chat"]')`);
  await click("loom-open-chat");
  await until(`!!document.querySelector('[data-testid="record-button"]')`);
  await run(
    `document.querySelector('[data-testid="loom-panel"] button[aria-label="Свернуть"]')?.click()`,
  );
  await click("record-button");
  await until(`!!document.querySelector('[data-testid="record-start"]')`);
  await click("record-start");
  await until(`!!document.querySelector('[data-testid="recording-bar"][data-phase="recording"]')`);
  await sleep(1000);
  const devices = await run(
    `({ camera: !!document.querySelector('[data-testid="recording-camera-preview"]'), microphone: !document.querySelector('[data-testid="recording-no-mic"]') })`,
  );
  console.log("camera and microphone in:", JSON.stringify(devices));
  // A real second tab in front: Work's tab goes to the background.
  const browserWs = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()))
    .webSocketDebuggerUrl;
  const browserSend = await connect(browserWs);
  const created = await browserSend("Target.createTarget", { url: "about:blank" });
  await sleep(800);
  const hidden = await run("document.visibilityState");
  await sleep(4200);
  await browserSend("Target.activateTarget", { targetId: page.id });
  await browserSend("Target.closeTarget", { targetId: created.result.targetId });
  await sleep(1000);
  await click("recording-stop");
  await until(`!!document.querySelector('[data-testid="recording-thumb"] video')`, 20000);
  const result = await run(`(async () => {
    const video = document.querySelector('[data-testid="recording-thumb"] video');
    const blob = await fetch(video.src).then((r) => r.blob());
    const probe = document.createElement("video");
    probe.muted = true; probe.playbackRate = 2; probe.src = URL.createObjectURL(blob);
    const ended = new Promise((r) => probe.addEventListener("ended", r, { once: true }));
    await probe.play().catch(() => undefined);
    await Promise.race([ended, new Promise((r) => setTimeout(r, 15000))]);
    const q = probe.getVideoPlaybackQuality();
    return { size: blob.size, frames: q.totalVideoFrames, t: probe.currentTime, label: document.querySelector('[data-testid="recording-thumb"]').innerText };
  })()`);
  console.log(`Work's tab while away: ${hidden}`);
  console.log(
    `recording ${result.label}: ${result.size} B, ${result.frames} frames over ${result.t.toFixed(1)} s (${(result.frames / result.t).toFixed(1)} fps)`,
  );
  const ok = hidden === "hidden" && result.frames >= result.t * 15;
  console.log(
    ok ? "✓ kept drawing in the background" : "✗ drawing stalled (or the tab never went hidden)",
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  chrome.kill();
  server.close();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}
