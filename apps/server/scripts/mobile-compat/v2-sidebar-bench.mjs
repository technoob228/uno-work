#!/usr/bin/env node
// Sidebar speed bench for the T3 v2 / server read-state work (Misha 29.10:
// "регрессия больше 1 кадра — блокер"). Cloud only (v2-sidebar-bench.sh);
// never on the Mac.
//
//   node v2-sidebar-bench.mjs seed      <base> <pairToken> <chats> <turnChats> <out.json>
//   node v2-sidebar-bench.mjs unread    <base> <pairToken> <ids.json>
//   node v2-sidebar-bench.mjs phone     <base> <pairToken> <threadId>
//   node v2-sidebar-bench.mjs measure   <base> <pairToken> <label> <ids.json> <out.json>
//
// measure: a fresh Chromium profile pairs with the daemon, waits for the
// sidebar, then clicks each unread chat with a finished turn and records
//   - click → DOM: ms from click() until the URL has the chat and its row
//     changed (MutationObserver time, no frame rounding),
//   - click → paint: the same plus the next animation frame,
//   - React commits (whole app) and sidebar DOM mutations in the first
//     300 ms and over 2.5 s (that window covers the debounced thread.visit
//     at 600 ms and its echo back from the server),
//   - idle commits over 5 s with nobody touching anything.
// React commits come from a stub __REACT_DEVTOOLS_GLOBAL_HOOK__ (works in the
// production build).
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const [mode, BASE, PAIR, ...rest] = process.argv.slice(2);
const HARNESS = process.env.BENCH_HARNESS ?? "harness-fake";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function bearer(pairToken) {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: pairToken,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "sidebar bench",
    }),
  });
  if (!response.ok) throw new Error(`oauth ${response.status} ${await response.text()}`);
  return (await response.json()).access_token;
}

const now = () => new Date().toISOString();

async function dispatch(token, command) {
  const response = await fetch(`${BASE}/api/orchestration/dispatch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ commandId: randomUUID(), ...command }),
  });
  if (!response.ok) throw new Error(`${command.type}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function shell(token) {
  const response = await fetch(`${BASE}/api/orchestration/shell`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`shell ${response.status}`);
  return response.json();
}

async function seed(chats, turnChats, out) {
  const token = await bearer(PAIR);
  const snapshot = await shell(token);
  const project = snapshot.projects.find((p) => p.title === "T3 smoke") ?? snapshot.projects[0];
  if (!project) throw new Error("no project");
  const modelSelection = { instanceId: HARNESS, model: "fake-1" };
  const ids = [];
  for (let i = 0; i < chats; i += 1) {
    const threadId = randomUUID();
    await dispatch(token, {
      type: "thread.create",
      threadId,
      projectId: project.id,
      title: `Bench chat ${String(i).padStart(3, "0")}`,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: now(),
    });
    ids.push(threadId);
  }
  // The last `turnChats` get one finished turn each (one agent at a time, so
  // the machine never runs more than one fake agent).
  const turnIds = ids.slice(-turnChats);
  for (const threadId of turnIds) {
    await dispatch(token, {
      type: "thread.turn.start",
      threadId,
      message: { messageId: randomUUID(), role: "user", text: "hi", attachments: [] },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: now(),
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const row = (await shell(token)).threads.find((t) => t.id === threadId);
      if (row?.latestTurn?.completedAt) break;
      if (Date.now() > deadline) throw new Error(`turn in ${threadId} did not finish`);
      await sleep(250);
    }
    await dispatch(token, { type: "thread.session.stop", threadId, createdAt: now() }).catch(() => {});
  }
  writeFileSync(out, JSON.stringify(turnIds));
  console.log(`seeded ${chats} chats, ${turnIds.length} with a finished turn`);
}

async function unread(idsFile) {
  const token = await bearer(PAIR);
  for (const threadId of JSON.parse(readFileSync(idsFile, "utf8"))) {
    await dispatch(token, { type: "thread.mark-unread", threadId });
  }
  console.log("server read marks cleared");
}

async function phone(threadId) {
  const token = await bearer(PAIR);
  const { ticket } = await (
    await fetch(`${BASE}/api/auth/websocket-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    })
  ).json();
  const url = new URL(`${BASE.replace(/^http/, "ws")}/ws`);
  for (const [key, value] of Object.entries({
    wsTicket: ticket,
    orchestrationProtocol: "2",
    clientSurface: "mobile",
    clientDeviceType: "phone",
    connectionMethod: "direct",
    clientOs: "ios",
    clientAppVersion: "bench",
  })) {
    url.searchParams.set(key, value);
  }
  const ws = new WebSocket(url);
  const counts = { shell: 0, thread: 0, bytes: 0 };
  const tagById = { 1: "shell", 2: "thread", 3: "config" };
  ws.onopen = () => {
    const request = (id, tag, payload) =>
      ws.send(JSON.stringify({ _tag: "Request", id: String(id), tag, payload, headers: [] }));
    request(1, "orchestration.subscribeShell", {});
    request(2, "orchestration.subscribeThread", { threadId });
    request(3, "subscribeServerConfig", {});
  };
  ws.onmessage = (event) => {
    counts.bytes += event.data.length;
    const frame = JSON.parse(event.data);
    if (frame._tag === "Chunk") {
      const kind = tagById[frame.requestId];
      if (kind in counts) counts[kind] += frame.values.length;
      ws.send(JSON.stringify({ _tag: "Ack", requestId: frame.requestId }));
    } else if (frame._tag === "Ping") {
      ws.send(JSON.stringify({ _tag: "Pong" }));
    } else if (frame._tag === "Exit" || frame._tag === "Defect") {
      console.log("phone:", JSON.stringify(frame).slice(0, 300));
    }
  };
  ws.onclose = (event) => {
    console.log(`phone socket closed ${event.code}`);
    process.exit(1);
  };
  const ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ _tag: "Ping" })), 10_000);
  const report = () => console.log(`phone frames: ${JSON.stringify(counts)}`);
  process.on("SIGTERM", () => {
    clearInterval(ping);
    report();
    process.exit(0);
  });
  setInterval(report, 15_000);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
};
const p95 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : null;
};
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

async function measure(label, idsFile, out) {
  const { chromium } = await import(
    process.env.PW_CORE ?? "/opt/uno-work/app/node_modules/playwright-core/index.mjs"
  );
  const ids = JSON.parse(readFileSync(idsFile, "utf8"));
  const browser = await chromium.launch({
    executablePath:
      process.env.BENCH_CHROME ?? "/opt/uno-work/browsers/chromium-1208/chrome-linux64/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    window.__benchCommits = 0;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject: () => 1,
      onScheduleFiberRoot() {},
      onCommitFiberRoot() {
        window.__benchCommits += 1;
      },
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      checkDCE() {},
    };
  });
  const page = await context.newPage();
  await page.goto(`${BASE}/pair#token=${PAIR}`);
  await page.waitForFunction(
    (first) => document.querySelector(`[data-testid="thread-title-${first}"]`) !== null,
    ids[ids.length - 1],
    { timeout: 120_000 },
  );
  const rows = await page.evaluate(() => document.querySelectorAll("[data-thread-item]").length);
  await sleep(8_000); // first sync, backfill, late snapshots
  const idleCommits = await page.evaluate(async () => {
    const start = window.__benchCommits;
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    return window.__benchCommits - start;
  });

  const clicks = [];
  // Newest first, like a person going down the list.
  for (const id of [...ids].reverse()) {
    const result = await page.evaluate(async (threadId) => {
      const rowOf = () =>
        document.querySelector(`[data-testid="thread-title-${threadId}"]`)?.closest('[role="button"]');
      const row = rowOf();
      if (!row) return { threadId, missing: true };
      row.scrollIntoView({ block: "center" });
      await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 50)));
      const sidebar = row.closest('[data-sidebar="content"]') ?? row.closest("ul")?.parentElement ?? document.body;
      const unreadBefore = row.getAttribute("data-thread-mark");
      const beforeClass = row.className;
      let sidebarMutations = 0;
      const counter = new MutationObserver((records) => (sidebarMutations += records.length));
      counter.observe(sidebar, { subtree: true, childList: true, attributes: true, characterData: true });
      const c0 = window.__benchCommits;
      let tDom = null;
      const t0 = performance.now();
      const changed = new Promise((resolve) => {
        const check = () => {
          const current = rowOf();
          if (location.pathname.includes(threadId) && current && current.className !== beforeClass) {
            tDom = performance.now() - t0;
            return true;
          }
          return false;
        };
        const watcher = new MutationObserver(() => {
          if (check()) {
            watcher.disconnect();
            resolve();
          }
        });
        watcher.observe(document.body, { subtree: true, childList: true, attributes: true });
        setTimeout(() => {
          watcher.disconnect();
          resolve();
        }, 3_000);
      });
      row.click();
      await changed;
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const tPaint = performance.now() - t0;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 300 - (performance.now() - t0))));
      const commitsEarly = window.__benchCommits - c0;
      const mutationsEarly = sidebarMutations;
      await new Promise((resolve) => setTimeout(resolve, 2_200));
      counter.disconnect();
      return {
        threadId,
        unreadBefore,
        unreadAfter: rowOf()?.getAttribute("data-thread-mark") ?? null,
        tDom,
        tPaint,
        commitsEarly,
        commitsTotal: window.__benchCommits - c0,
        mutationsEarly,
        mutationsTotal: sidebarMutations,
      };
    }, id);
    clicks.push(result);
  }
  await browser.close();

  const ok = clicks.filter((click) => !click.missing && click.tDom !== null);
  const summary = {
    label,
    rows,
    clicks: clicks.length,
    measured: ok.length,
    idleCommits5s: idleCommits,
    domMedianMs: median(ok.map((c) => c.tDom)),
    domP95Ms: p95(ok.map((c) => c.tDom)),
    paintMedianMs: median(ok.map((c) => c.tPaint)),
    paintP95Ms: p95(ok.map((c) => c.tPaint)),
    commitsEarlyMean: mean(ok.map((c) => c.commitsEarly)),
    commitsTotalMean: mean(ok.map((c) => c.commitsTotal)),
    sidebarMutationsEarlyMean: mean(ok.map((c) => c.mutationsEarly)),
    sidebarMutationsTotalMean: mean(ok.map((c) => c.mutationsTotal)),
  };
  writeFileSync(out, JSON.stringify({ summary, clicks }, null, 2));
  console.log(JSON.stringify(summary));
}

switch (mode) {
  case "seed":
    await seed(Number(rest[0]), Number(rest[1]), rest[2]);
    break;
  case "unread":
    await unread(rest[0]);
    break;
  case "phone":
    await phone(rest[0]);
    break;
  case "measure":
    await measure(rest[0], rest[1], rest[2]);
    break;
  default:
    console.error("usage: seed | unread | phone | measure (see header)");
    process.exit(2);
}
