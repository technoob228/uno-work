#!/usr/bin/env node
/*
 * Local stand-in for the Uno control plane (console.uno4.dev), enough for the
 * "This computer" screen of Uno Work to be exercised end to end without prod.
 * Zero dependencies. Adapted from uno-console's scripts/mock-observability.mjs
 * (same fixtures and install simulation), with English copy for Work.
 *
 * Run it, then point the daemon at it:
 *
 *   node apps/server/scripts/mock-control-plane.mjs            # :8091, scenario "happy"
 *   UNO_WORK_DEV_CONTROL_PLANE_URL=http://127.0.0.1:8091 UNO_BOX_ID=123 \
 *     T3CODE_HOME=/tmp/t3-computer node apps/server/src/bin.ts serve
 *
 * and put any non-empty Uno API key into the daemon's settings (the mock
 * accepts every key).
 *
 * Scenarios (env MOCK_SCENARIO or argv[2]):
 *   happy        running computer, live metrics, logs, a 6-app catalog
 *   not-deployed only the routes that are in production today: box, ports,
 *                power, git services. Metrics, applogs and the App Store 404
 *                — the screen must say "coming soon", not show errors.
 *   sleeping     the computer is asleep
 *   node-down    /metrics answers 502 {"ok":false,"error":"node unreachable"}
 *   fleet        an account with several named boxes, for the machine flows of
 *                Uno Work (Connect / Create a box / Wake / Sleep). Box 123 is
 *                the computer serving Work; 201 "night-owl" is asleep; 202
 *                "outreach-machine" runs something else; 203 is not responding,
 *                204 is a second Uno Work computer, 205 has an app that didn't
 *                install, 206 is a stopped server. "Create a box" works:
 *                the box boots in ~6 s, and its public address then hangs
 *                (like a not-yet-routed edge) for MOCK_ADDRESS_DELAY_MS
 *                (default 25 s). Each box that runs Uno Work gets a local
 *                "edge" port that proxies HTTP + WebSocket to a real daemon;
 *                asleep → 502 without CORS, exactly what prod's edge does.
 *
 *                Daemons for the boxes are real `t3 serve` processes you start
 *                yourself; tell the mock where they are:
 *                  MOCK_SLEEPING_DAEMON=/tmp/t3-c:13779   (box 201)
 *                  MOCK_NEW_BOX_DAEMON=/tmp/t3-b:13778    (created boxes)
 *                The mock mints pairing links on them with
 *                `node src/bin.ts auth pairing create --base-dir … --json`.
 *
 * Power is stateful: POST /sleep|/wake|/stop|/start flips the status the next
 * GET returns. Installs take ~6 s and then show up as a git service with a URL.
 *
 * App cards (GET /boxes/{id}/apps): Memos and Open WebUI come preinstalled —
 * with sign-in details, web port, compose project, and (Open WebUI) an AI key.
 * DELETE /boxes/{id}/apps/{deployment_id}?delete_data= takes ~3 s and removes
 * the app; PATCH …/apps/{deployment_id} {"ai_limit_usd": n|null} sets the
 * AI limit. MOCK_REMOVE=old answers DELETE/PATCH like a console from before
 * app removal (405); MOCK_REMOVE=fail answers 502 APP_REMOVE_FAILED.
 *
 * Boost ×2 (GET /boxes/{id} → "boost", POST|DELETE /boxes/{id}/boost): on by
 * default in every scenario but "not-deployed". POST switches off → starting →
 * (MOCK_BOOST_SWITCH_MS, default 4 s) active for MOCK_BOOST_MINUTES (default
 * 60), then ending → off; DELETE ends it early the same way. The box reports
 * the doubled size while boosted. MOCK_BOOST=off hides boost (switched off by
 * Uno); MOCK_BOOST=unavailable is a plan with no boost hours;
 * MOCK_BOOST=no-capacity answers 409 BOOST_NO_CAPACITY; MOCK_BOOST=limit has
 * this month's hours used up (429 BOOST_HOURS_USED_UP). MOCK_BOOST=active starts
 * boosted, 43 minutes left.
 */
import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT || 8091);
const SCENARIO = process.env.MOCK_SCENARIO || process.argv[2] || "happy";
const MOCK_STARTED_AT = Date.now();
const BOX_ID = Number(process.env.MOCK_BOX_ID || 123);

const iso = (d) => d.toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60_000);

const STARTED_AT = iso(new Date(Date.now() - (3 * 86400 + 4 * 3600) * 1000));
let statusOverride = null;
let startedAtOverride = null;

function status() {
  // In "fleet" the box list owns the power state of box 123 as well.
  if (SCENARIO === "fleet" && typeof fleet !== "undefined" && fleet.has(BOX_ID)) {
    return fleet.get(BOX_ID).status;
  }
  if (statusOverride) return statusOverride;
  return SCENARIO === "sleeping" ? "sleeping" : "running";
}

// "Add memory / cores": the computer's size, and a Pro-like plan that lets one
// computer reach 8 GB / 4 cores and the account run 12 GB / 6 cores at once
// (another computer of the account holds 6 GB / 3 cores). Same checks and
// codes as prod's ResizeBox (ValidateShape → CheckPeak → CheckDisk).
const SHAPE = { ram_mb: 2048, vcpu: 2, disk_gb: 30 };
const PLAN = {
  slug: "pro",
  max_box: { ram_mb: 8192, vcpu: 4 },
  peak: { ram_mb: 12288, vcpu: 6 },
  disk_gb: 80,
};
const OTHERS = { ram_mb: 6144, vcpu: 3, disk_gb: 20 };

function subscription() {
  const running = status() === "running";
  return {
    id: 1,
    plan: PLAN.slug,
    status: "active",
    plan_limits: PLAN,
    usage: {
      running_ram_mb: OTHERS.ram_mb + (running ? SHAPE.ram_mb : 0),
      running_vcpu: OTHERS.vcpu + (running ? SHAPE.vcpu : 0),
      disk_gb_used: OTHERS.disk_gb + SHAPE.disk_gb,
    },
  };
}

function resizeRefusal(req) {
  if (req.disk_gb < SHAPE.disk_gb) return "DISK_SHRINK_UNSUPPORTED";
  if (req.ram_mb > PLAN.max_box.ram_mb || req.vcpu > PLAN.max_box.vcpu) return "SHAPE_TOO_LARGE";
  if (req.disk_gb > PLAN.disk_gb) return "DISK_QUOTA_EXCEEDED";
  if (status() === "running") {
    if (OTHERS.ram_mb + req.ram_mb > PLAN.peak.ram_mb) return "PEAK_EXCEEDED";
    if (OTHERS.vcpu + req.vcpu > PLAN.peak.vcpu) return "PEAK_EXCEEDED";
  }
  if (OTHERS.disk_gb + req.disk_gb > PLAN.disk_gb) return "DISK_QUOTA_EXCEEDED";
  return null;
}

// Boost ×2 for an hour — same contract as prod's /boxes/{id}/boost.
const BOOST_MODE = process.env.MOCK_BOOST || (SCENARIO === "not-deployed" ? "off" : "on");
const BOOST_SWITCH_MS = Number(process.env.MOCK_BOOST_SWITCH_MS || 4000);
const BOOST_MINUTES = Number(process.env.MOCK_BOOST_MINUTES || 60);
const BOOST_HOURS_PER_MONTH = 10; // a Plus plan
const boost = {
  state: BOOST_MODE === "active" ? "active" : "off",
  startedAt: BOOST_MODE === "active" ? iso(minsAgo(17)) : null,
  endsAt: BOOST_MODE === "active" ? iso(new Date(Date.now() + 43 * 60_000)) : null,
  hoursUsed: BOOST_MODE === "limit" ? BOOST_HOURS_PER_MONTH : BOOST_MODE === "active" ? 1 : 0,
  timer: null,
};

function boostSwitch(to, after) {
  clearTimeout(boost.timer);
  boost.timer = setTimeout(() => {
    boost.state = to;
    console.log(`boost → ${to}`);
    if (to === "active") {
      const ms = new Date(boost.endsAt).getTime() - Date.now();
      boost.timer = setTimeout(() => boostEnd(), Math.max(0, ms));
    }
    if (to === "off") {
      boost.startedAt = null;
      boost.endsAt = null;
    }
  }, after);
}

function boostEnd() {
  boost.state = "ending";
  console.log("boost → ending");
  boostSwitch("off", BOOST_SWITCH_MS);
}
if (boost.state === "active") boostSwitch("active", 0);

function boostJson() {
  if (BOOST_MODE === "off") return null;
  const perMonth = BOOST_MODE === "unavailable" ? 0 : BOOST_HOURS_PER_MONTH;
  const hoursLeft = Math.max(0, perMonth - boost.hoursUsed);
  const now = new Date();
  const resets = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  let reason = "";
  if (BOOST_MODE === "unavailable") reason = "Your plan has no boost hours.";
  else if (hoursLeft === 0)
    reason = `Boost hours are used up until ${resets.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}.`;
  else if (status() !== "running") reason = "Turn your computer on to boost it.";
  return {
    available: boost.state === "off" && reason === "",
    state: boost.state,
    ram_mb: SHAPE.ram_mb * 2,
    vcpu: SHAPE.vcpu * 2,
    base_ram_mb: SHAPE.ram_mb,
    base_vcpu: SHAPE.vcpu,
    hours: 1,
    started_at: boost.startedAt,
    ends_at: boost.endsAt,
    hours_per_month: perMonth,
    hours_used: Math.min(boost.hoursUsed, perMonth),
    hours_left: hoursLeft,
    period_resets_at: iso(resets),
    hours_left_today: hoursLeft,
    hours_per_day: perMonth,
    reason,
  };
}

/** POST /boxes/{id}/boost → [status, body]. */
function boostStart(hours) {
  if (BOOST_MODE === "off" || BOOST_MODE === "unavailable") {
    return [403, { error: "BOOST_NOT_AVAILABLE" }];
  }
  if (hours !== 1) return [400, { error: "BOOST_INVALID_HOURS" }];
  if (boost.state !== "off") return [409, { error: "BOOST_ACTIVE" }];
  if (status() !== "running") return [409, { error: "BOX_NOT_RUNNING" }];
  if (BOOST_MODE === "no-capacity") return [409, { error: "BOOST_NO_CAPACITY" }];
  if (boost.hoursUsed >= BOOST_HOURS_PER_MONTH) return [429, { error: "BOOST_HOURS_USED_UP" }];
  boost.hoursUsed += 1;
  boost.state = "starting";
  boost.startedAt = iso(new Date());
  boost.endsAt = iso(new Date(Date.now() + BOOST_SWITCH_MS + BOOST_MINUTES * 60_000));
  console.log("boost → starting");
  boostSwitch("active", BOOST_SWITCH_MS);
  return [202, { boost: boostJson() }];
}

/** DELETE /boxes/{id}/boost → [status, body]. */
function boostStop() {
  if (boost.state !== "active") return [409, { error: "BOOST_NOT_ACTIVE" }];
  clearTimeout(boost.timer);
  boostEnd();
  return [202, { boost: boostJson() }];
}

function box() {
  const s = status();
  const boosted = boost.state === "active" && BOOST_MODE !== "off";
  const boostInfo = boostJson();
  return {
    id: BOX_ID,
    name: "my-computer",
    status: s,
    os: "ubuntu-24.04",
    ram_mb: boosted ? SHAPE.ram_mb * 2 : SHAPE.ram_mb,
    vcpu: boosted ? SHAPE.vcpu * 2 : SHAPE.vcpu,
    disk_gb: SHAPE.disk_gb,
    created_at: iso(minsAgo(60 * 24 * 32)),
    started_at: s === "running" ? (startedAtOverride ?? STARTED_AT) : null,
    internal_ip: "10.77.0.14",
    network_public_ip: "203.0.113.42",
    ssh_command: "ssh -p 40122 uno@203.0.113.42",
    hostname: "my-computer.u85.uno4.me",
    ...(boostInfo ? { boost: boostInfo } : {}),
  };
}

const PORTS = [
  {
    id: 1,
    internal_port: 22,
    external_port: 40122,
    protocol: "tcp",
    visibility: "public",
    state: "applied",
  },
  {
    id: 2,
    internal_port: 80,
    external_port: 40180,
    protocol: "tcp",
    visibility: "public",
    state: "applied",
  },
];
let nextPortId = 10;

const SERVICES = [
  {
    id: -77,
    repo_full_name: "memos",
    branch: "main",
    box_id: BOX_ID,
    last_deployment_id: 77,
    last_status: "success",
    url: "https://memos-my-computer.app.uno4.dev",
  },
  {
    id: -78,
    repo_full_name: "open-webui",
    branch: "main",
    box_id: BOX_ID,
    last_deployment_id: 78,
    last_status: "success",
    url: "https://open-webui-my-computer.app.uno4.dev",
  },
  {
    id: 7,
    repo_full_name: "acme/status-page",
    branch: "main",
    box_id: BOX_ID,
    last_deployment_id: 91,
    last_status: "success",
    url: "https://status-page.my-computer.u85.uno4.me",
  },
];

function history() {
  const points = [];
  for (let i = 60; i >= 0; i--) {
    const phase = (60 - i) / 60;
    const wave = 42.5 + 37.5 * Math.sin(phase * Math.PI * 3 - 1.2);
    const noise = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
    const cpu = Math.min(80, Math.max(5, wave + noise * 6 - 3));
    const mem = Math.round(700 + 190 / (1 + Math.exp(-(phase - 0.45) * 10)));
    points.push({ t: iso(minsAgo(i)), cpu_pct: Math.round(cpu * 10) / 10, mem_mb: mem });
  }
  return points;
}

function metrics() {
  const h = history();
  const last = h[h.length - 1];
  // A little movement between polls so "Live" visibly lives.
  const jitter = Math.round((Math.random() * 8 - 4) * 10) / 10;
  return {
    ok: true,
    box_id: BOX_ID,
    live: true,
    sampled_at: last.t,
    uptime_s: Math.floor((Date.now() - Date.parse(STARTED_AT)) / 1000),
    cpu: { usage_pct: Math.max(1, last.cpu_pct + jitter), vcpu: 2 },
    mem: { used_mb: last.mem_mb, limit_mb: 2048 },
    disk: { used_gb: 4.2, total_gb: 30 },
    history: h,
  };
}

const LOG_LINES = [
  "systemd[1]: Started status-page.service - Status page.",
  "status-page[412]: listening on 0.0.0.0:3000",
  "status-page[412]: GET / 200 4ms",
  "cron[88]: (uno) CMD (backup-notes.sh)",
  "status-page[412]: GET /api/status 200 2ms",
  "status-page[412]: WARN slow upstream check example.com 812ms",
  "status-page[412]: check example.com ok (91ms)",
  "sshd[9917]: Accepted publickey for uno from 198.51.100.7 port 52114 ssh2",
  "uno-work[201]: agent finished task: summarize inbox (12.4s)",
  "status-page[412]: GET /healthz 200 0ms",
];

function applogs(tail) {
  const n = LOG_LINES.length;
  const lines = LOG_LINES.map((line, idx) => {
    const t = minsAgo(((n - idx) * 40) / n);
    const stamp = t.toTimeString().slice(0, 8);
    return { line: `Sep 21 ${stamp} my-computer ${line}` };
  });
  return { ok: true, source: "journal", lines: lines.slice(-tail), truncated: false };
}

const TEMPLATES = [
  {
    id: "hello-uno",
    name: "hello-uno",
    icon: "👋",
    category: "demo",
    description_en: "A tiny page that says hello from your computer — proof it serves the web.",
    min_ram_mb: 128,
    min_disk_gb: 1,
  },
  {
    id: "uptime-kuma",
    name: "Uptime Kuma",
    icon: "📈",
    category: "monitoring",
    description_en:
      "Watches your websites and tells you the moment one goes down, with a friendly status page.",
    min_ram_mb: 512,
    min_disk_gb: 1,
  },
  {
    id: "n8n",
    name: "n8n",
    icon: "🔁",
    category: "automation",
    description_en: "Connect Telegram, spreadsheets, email and any API into automations — no code.",
    min_ram_mb: 1024,
    min_disk_gb: 2,
    env: [
      {
        name: "N8N_ADMIN_EMAIL",
        description_en: "Email to sign in with",
        secret: false,
        default: "me@example.com",
      },
      { name: "N8N_ADMIN_PASSWORD", description_en: "Admin password — pick one", secret: true },
    ],
  },
  {
    id: "ghost",
    name: "Ghost",
    icon: "👻",
    category: "blog",
    description_en: "A full blog with an editor, subscribers and newsletters — entirely yours.",
    min_ram_mb: 1024,
    min_disk_gb: 2,
  },
  {
    id: "filebrowser",
    name: "FileBrowser",
    icon: "📁",
    category: "files",
    description_en: "Browse, upload and share the files on your computer from any browser.",
    min_ram_mb: 256,
    min_disk_gb: 1,
  },
  {
    id: "memos",
    name: "Memos",
    icon: "📝",
    category: "notes",
    description_en: "Quick notes and a timeline of your thoughts, private to you.",
    min_ram_mb: 256,
    min_disk_gb: 1,
  },
  {
    id: "open-webui",
    name: "Open WebUI",
    icon: "💬",
    category: "ai",
    description_en: "Your own ChatGPT-style chat, with Uno's AI behind it.",
    min_ram_mb: 1024,
    min_disk_gb: 2,
  },
  {
    id: "static-site",
    name: "Static site",
    icon: "🌐",
    category: "website",
    description_en: "Drop HTML into a folder and it's live at your computer's address.",
    min_ram_mb: 128,
    min_disk_gb: 1,
  },
];

/** Rows of GET /boxes/{id}/apps, by deployment id. */
const APP_CARDS = new Map([
  [
    77,
    {
      deployment_id: 77,
      template_id: "memos",
      name: "Memos",
      icon: "📝",
      status: "running",
      url: "https://memos-my-computer.app.uno4.dev",
      created_at: iso(minsAgo(60 * 24)),
      credentials: [
        { label_en: "Login", value: "owner" },
        { label_en: "Password", value: "k2-violet-harbor", secret: true },
      ],
      notes_en: "Sign in with the login and password below.",
      removable: true,
      web_port: 5230,
      compose_project: "uno-memos",
      ai_key: null,
      sso: "oidc",
      shared_with: 1,
    },
  ],
  [
    78,
    {
      deployment_id: 78,
      template_id: "open-webui",
      name: "Open WebUI",
      icon: "💬",
      status: "running",
      url: "https://open-webui-my-computer.app.uno4.dev",
      created_at: iso(minsAgo(60 * 5)),
      credentials: [{ label_en: "Email", value: "demo@uno4.dev" }],
      notes_en: null,
      removable: true,
      web_port: 8080,
      compose_project: "uno-open-webui",
      ai_key: { limit_usd: 10, spent_usd: 0.12 },
      sso: null,
    },
  ],
]);

const DEPLOYMENTS = new Map();
let nextDeploymentId = 500;
let nextServiceId = 100;

function push(dep, text, depStatus) {
  if (depStatus) dep.status = depStatus;
  if (text)
    dep.lines.push({ seq: ++dep.seq, stream: "stdout", line: text, created_at: iso(new Date()) });
}

function startInstall(template, env) {
  const dep = { id: nextDeploymentId++, status: "queued", done: false, seq: 0, lines: [] };
  const serviceId = nextServiceId++;
  const url = `https://${template.id}.my-computer.u85.uno4.me`;
  DEPLOYMENTS.set(dep.id, dep);
  push(dep, `Getting ${template.name} ready for your computer`);
  const steps = [
    [800, "cloning", `Downloading ${template.name}`],
    [1800, "building", "Unpacking the app…"],
    [
      3000,
      "building",
      env && Object.keys(env).length
        ? `Applying settings: ${Object.keys(env).join(", ")}`
        : "Setting it up",
    ],
    [4200, "deploying", "Starting it and giving it an address"],
    [5300, "deploying", "Checking it answers: HTTP 200"],
  ];
  for (const [ms, s, text] of steps) setTimeout(() => push(dep, text, s), ms);
  setTimeout(() => {
    push(dep, `Done — ${template.name} is running at ${url}`, "success");
    dep.done = true;
    APP_CARDS.set(dep.id, {
      deployment_id: dep.id,
      template_id: template.id,
      name: template.name,
      icon: template.icon,
      status: "running",
      url,
      created_at: iso(new Date()),
      credentials: [],
      notes_en: null,
      removable: true,
      web_port: null,
      compose_project: `uno-${template.id}`,
      ai_key: template.id === "open-webui" ? { limit_usd: 10, spent_usd: 0 } : null,
    });
    SERVICES.push({
      id: serviceId,
      repo_full_name: `apps/${template.id}`,
      branch: "main",
      box_id: BOX_ID,
      last_deployment_id: dep.id,
      last_status: "success",
      url,
    });
  }, 6200);
  return dep;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** A Go ServeMux 404 is plain text — the shape a not-yet-deployed route has. */
function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 page not found\n");
}

const NOT_DEPLOYED = /^\/api\/v1\/(boxes\/\d+\/(metrics|applogs|apps)|apps\/templates)$/;

// ---------------------------------------------------------------- fleet ---

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let ADDRESS_DELAY_MS = Number(process.env.MOCK_ADDRESS_DELAY_MS || 25_000);
const BOOT_MS = Number(process.env.MOCK_BOOT_MS || 6_000);
const WAKE_MS = Number(process.env.MOCK_WAKE_MS || 5_000);

function parseDaemon(spec) {
  if (!spec) return null;
  const [home, port] = spec.split(":");
  return { home, port: Number(port) };
}

const fleet = new Map();
let nextBoxId = 300;
let nextEdgePort = 18300;

function fleetBox(id, name, status, daemon, edgePort) {
  const b = {
    id,
    name,
    status,
    daemon,
    edgePort,
    ramMb: 2048,
    vcpu: 1,
    diskGb: 10,
    createdAt: iso(minsAgo(60 * 24 * 3)),
    addressReadyAt: 0,
    edge: null,
    comment: "",
    computerRole: null,
    workMachine: Boolean(daemon),
  };
  fleet.set(id, b);
  if (daemon && edgePort) startEdge(b);
  return b;
}

// Like the console after migration 139: an explicit computer_role wins; a
// "[role] " tag at the start of the comment (Uno Work 0.0.77) is moved into
// the field and cut from the note.
const ROLE_TAG = /^\s*\[(workspace|server|production|staging|sandbox)\]\s*/i;
function applyRoleLabels(b, body) {
  if (typeof body.comment === "string") {
    const tag = ROLE_TAG.exec(body.comment);
    b.comment = (tag ? body.comment.slice(tag[0].length) : body.comment).trim();
    if (tag) b.computerRole = tag[1].toLowerCase();
  }
  if ("computer_role" in body) b.computerRole = body.computer_role || null;
}

function fleetJson(b) {
  const hasEdge = b.daemon && b.edgePort;
  return {
    id: b.id,
    name: b.name,
    status: b.status,
    os: "ubuntu-24.04",
    ram_mb: b.ramMb,
    vcpu: b.vcpu,
    disk_gb: b.diskGb,
    created_at: b.createdAt,
    internal_ip: `10.77.0.${b.id % 250}`,
    ssh_command: `ssh -p ${40000 + b.id} uno@203.0.113.42`,
    comment: b.comment,
    computer_role: b.computerRole,
    work_machine: b.workMachine,
    always_on: !b.workMachine,
    started_at: b.status === "running" ? b.createdAt : null,
    ...(hasEdge
      ? { hostname: `127.0.0.1:${b.edgePort}`, url: `http://127.0.0.1:${b.edgePort}` }
      : {}),
  };
}

function setStatusLater(b, status, ms) {
  setTimeout(() => {
    b.status = status;
    console.log(`box #${b.id} ${b.name} → ${status}`);
  }, ms);
}

/**
 * The box's public address. Asleep/off → 502 text/plain with no CORS header
 * (the browser sees "Failed to fetch"). Freshly booted → the request hangs
 * until the address is "routed". Otherwise HTTP and WebSocket go to the daemon.
 */
function startEdge(b) {
  const edge = http.createServer((req, res) => {
    if (b.status !== "running") {
      res.writeHead(502, { "Content-Type": "text/plain" });
      return res.end("502 Bad Gateway\n");
    }
    if (Date.now() < b.addressReadyAt) {
      console.log(`edge ${b.name}: not routed yet, hanging ${req.method} ${req.url}`);
      return; // never answers, like prod before the route exists
    }
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: b.daemon.port,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${b.daemon.port}` },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("502 Bad Gateway\n");
    });
    req.pipe(upstream);
  });
  edge.on("upgrade", (req, socket, head) => {
    if (b.status !== "running" || Date.now() < b.addressReadyAt) return socket.destroy();
    const up = net.connect(b.daemon.port, "127.0.0.1", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const value =
          name.toLowerCase() === "host" ? `127.0.0.1:${b.daemon.port}` : req.rawHeaders[i + 1];
        lines.push(`${name}: ${value}`);
      }
      up.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  edge.listen(b.edgePort, "127.0.0.1", () =>
    console.log(
      `edge for box #${b.id} ${b.name} on http://127.0.0.1:${b.edgePort} → :${b.daemon.port}`,
    ),
  );
  b.edge = edge;
}

function mintPairing(b) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "src/bin.ts",
        "auth",
        "pairing",
        "create",
        "--base-dir",
        b.daemon.home,
        "--base-url",
        `http://127.0.0.1:${b.edgePort}`,
        "--role",
        "owner",
        "--label",
        "mock-connect",
        "--json",
      ],
      { cwd: SERVER_DIR, timeout: 30_000 },
      (error, stdout) => {
        if (error) return reject(error);
        // --json prints one pretty-printed object after any log lines.
        const start = stdout.search(/^\{/m);
        try {
          resolve(JSON.parse(stdout.slice(start)));
        } catch (cause) {
          reject(cause);
        }
      },
    );
  });
}

function initFleet() {
  // With MOCK_PRIMARY_DAEMON the computer serving Work also has a public
  // address (edge on :18123), so "which address goes into the phone QR" can
  // be checked with the page opened from a different origin.
  const primaryDaemon = parseDaemon(process.env.MOCK_PRIMARY_DAEMON);
  fleetBox(BOX_ID, "my-computer", "running", primaryDaemon, primaryDaemon ? 18123 : null);
  fleetBox(201, "night-owl", "sleeping", parseDaemon(process.env.MOCK_SLEEPING_DAEMON), 18201);
  fleetBox(202, "outreach-machine", "running", null, null);
  fleetBox(203, "old-experiment", "error", null, null);
  // "My Uno": roles live in computer_role (console 139); Work computers are
  // workspaces.
  fleet.get(BOX_ID).workMachine = true;
  fleet.get(BOX_ID).ramMb = 4096;
  fleet.get(BOX_ID).vcpu = 2;
  fleet.get(BOX_ID).diskGb = 20;
  fleet.get(201).workMachine = true;
  fleet.get(202).computerRole = "production";
  fleet.get(202).comment = "sends the outreach emails";
  fleet.get(202).ramMb = 1024;
  fleet.get(203).computerRole = "sandbox";
  fleet.get(203).ramMb = 1024;
  // A few more for My Uno's rows: a second Uno Work computer (no daemon —
  // Open connects and fails, as for a machine without Work), a production
  // server where an app didn't install, a stopped bot.
  fleetBox(204, "design-lab", "running", null, null);
  fleet.get(204).workMachine = true;
  fleet.get(204).ramMb = 4096;
  fleet.get(204).vcpu = 2;
  fleetBox(205, "shop-api", "running", null, null);
  fleet.get(205).computerRole = "production";
  fleetBox(206, "tg-bot", "stopped", null, null);
  fleet.get(206).computerRole = "server";
  fleet.get(206).ramMb = 1024;
  fleet.get(206).comment = "the course bot";
}

// ---------------------------------------------------------------- My Uno ---
// The account in one window (Uno Work → My Uno): plans v2, sites, cloud,
// payments, roles, "Add computer" for servers, and a server's monitor/apps/logs.

const PLANS_V2 = [
  ["small", "Small", 5, 15, 20, 1, 1, 15, 25, 5],
  ["plus", "Plus", 20, 30, 50, 4, 2, 40, 100, 10],
  ["pro-v2", "Pro", 70, 50, 120, 16, 8, 120, 300, 20],
  ["max", "Max", 200, 100, 300, 48, 16, 300, 1024, 40],
].flatMap(([slug, name, compute, ai, aiPrice, ramGb, vcpu, disk, s3, boost]) =>
  [false, true].map((withAi) => ({
    slug: withAi ? `${slug}-ai` : slug,
    name,
    price_usd: withAi ? aiPrice : compute,
    compute_price_usd: compute,
    generation: 2,
    base_slug: slug,
    ai_bundle: withAi,
    ai_credits_usd: withAi ? ai : 0,
    max_box: { ram_mb: ramGb * 1024, vcpu },
    peak: { ram_mb: ramGb * 1024, vcpu },
    pool: { ram_hours: ramGb * 750, vcpu_hours: vcpu * 750 },
    disk_gb: disk,
    s3_gb: s3,
    boost_hours: boost,
    cloud_work: ramGb >= 4,
    legacy: false,
  })),
);
const MY_PLAN = PLANS_V2.find((p) => p.slug === (process.env.MOCK_PLAN || "pro-v2-ai"));

const SITES = [
  {
    slug: "q3-report-7f2a",
    size_bytes: 2_400_000,
    files_count: 12,
    has_password: true,
    updated_at: iso(minsAgo(60 * 5)),
  },
  {
    slug: "landing-caba",
    size_bytes: 18_700_000,
    files_count: 64,
    custom_domain: "caba.example.com",
    updated_at: iso(minsAgo(60 * 24 * 2)),
  },
  {
    slug: "wedding-photos",
    size_bytes: 120_000_000,
    files_count: 230,
    updated_at: iso(minsAgo(60 * 24 * 20)),
  },
].map((d, i) => ({ id: i + 1, url: `https://${d.slug}.uno4.dev`, has_password: false, ...d }));

const SERVER_APPS = new Map([
  [
    202,
    [
      {
        deployment_id: 901,
        template_id: "wg-easy",
        name: "WireGuard VPN",
        icon: "🛡️",
        status: "running",
        url: "https://wg-202.app.uno4.dev",
      },
      {
        deployment_id: 902,
        template_id: "n8n",
        name: "n8n",
        icon: "🔁",
        status: "running",
        url: "https://n8n-202.app.uno4.dev",
      },
    ],
  ],
  [
    204,
    [
      {
        deployment_id: 911,
        template_id: "open-webui",
        name: "Open WebUI",
        icon: "💬",
        status: "success",
        url: "https://open-webui-204.app.uno4.dev",
      },
    ],
  ],
  [
    205,
    [
      {
        deployment_id: 921,
        template_id: "uptime-kuma",
        name: "Uptime Kuma",
        icon: "📈",
        status: "success",
        url: "https://status.shop.example.com",
      },
      // What the console reports when an install didn't finish.
      {
        deployment_id: 922,
        template_id: "plausible",
        name: "Plausible",
        icon: "📊",
        status: "failed",
        url: null,
      },
    ],
  ],
  [
    BOX_ID,
    [
      {
        deployment_id: 77,
        template_id: "memos",
        name: "Memos",
        icon: "📝",
        status: "running",
        url: "https://memos-123.app.uno4.dev",
      },
    ],
  ],
]);

function myUnoSubscription() {
  const running = [...fleet.values()].filter((b) => b.status === "running");
  return {
    id: 1,
    plan: MY_PLAN.slug,
    status: "active",
    price_usd: MY_PLAN.price_usd,
    period_start: iso(minsAgo(60 * 24 * 9)),
    next_billing_at: iso(new Date(Date.now() + 21 * 86400_000)),
    pending_plan: null,
    plan_limits: MY_PLAN,
    ai_credits: {
      monthly_usd: MY_PLAN.ai_credits_usd,
      period_usd: MY_PLAN.ai_credits_usd,
      carry_usd: 4.2,
    },
    usage: {
      running_ram_mb: running.reduce((sum, b) => sum + b.ramMb, 0),
      running_vcpu: running.reduce((sum, b) => sum + b.vcpu, 0),
      disk_gb_used: [...fleet.values()].reduce((sum, b) => sum + b.diskGb, 0) * 0.6,
      box_count: fleet.size,
    },
  };
}

async function handleMyUno(req, res, url) {
  const p = url.pathname;
  const GET = req.method === "GET";
  if (GET && p === "/api/v1/box-subscription") return (send(res, 200, myUnoSubscription()), true);
  if (GET && p === "/api/v1/work/plans") {
    return (send(res, 200, { plans: PLANS_V2, plans_v2: true }), true);
  }
  if (GET && p === "/api/v1/work/sites") {
    const used = SITES.reduce((sum, d) => sum + d.size_bytes, 0);
    return (
      send(res, 200, {
        deploys: SITES,
        storage_used_bytes: used,
        storage_limit_bytes: 10 * 1024 ** 3,
      }),
      true
    );
  }
  if (GET && p === "/api/v1/buckets") {
    return (
      send(res, 200, {
        buckets: [{ id: 7, name: "files", used_bytes: 23.4 * 1024 ** 3, quota_bytes: 0 }],
        storage: {
          used_bytes: 23.4 * 1024 ** 3,
          quota_bytes: MY_PLAN.s3_gb * 1024 ** 3,
          over_quota: false,
        },
      }),
      true
    );
  }
  if (GET && p === "/pay/history") {
    return (
      send(res, 200, {
        success: true,
        payments: [
          {
            order_id: "d-1",
            amount: 100,
            payment_method: "direct",
            status: "completed",
            created_at: iso(minsAgo(60 * 24 * 9 + 30)),
            completed_at: iso(minsAgo(60 * 24 * 9 + 20)),
          },
          {
            order_id: "n-2",
            amount: 50,
            payment_method: "nowpayments",
            status: "expired",
            created_at: iso(minsAgo(60 * 24 * 15)),
          },
          {
            order_id: "d-3",
            amount: 25,
            payment_method: "direct",
            status: "completed",
            created_at: iso(minsAgo(60 * 24 * 40)),
            completed_at: iso(minsAgo(60 * 24 * 40)),
          },
        ],
      }),
      true
    );
  }
  if (GET && p === "/pay/spending") {
    return (
      send(res, 200, {
        success: true,
        spending: [
          {
            amount: -MY_PLAN.price_usd,
            category: "box_subscription",
            description: `Plan ${MY_PLAN.name}${MY_PLAN.ai_bundle ? " + Uno AI" : ""} — monthly`,
            created_at: iso(minsAgo(60 * 24 * 9)),
          },
          {
            amount: -10,
            category: "llm",
            description: "Uno AI credits",
            created_at: iso(minsAgo(60 * 24 * 12)),
          },
        ],
      }),
      true
    );
  }
  if (req.method === "POST" && p === "/api/v1/work/servers") {
    const body = await readBody(req);
    if (!body.name || !body.ram_mb) return (send(res, 400, { error: "MISSING_FIELDS" }), true);
    if (body.ram_mb > MY_PLAN.max_box.ram_mb) {
      return (
        send(res, 403, { error: "SHAPE_TOO_LARGE", detail: "Bigger than your plan allows" }), true
      );
    }
    const id = nextBoxId++;
    const b = fleetBox(id, body.name, "provisioning", null, null);
    b.ramMb = body.ram_mb;
    b.vcpu = body.vcpu;
    b.diskGb = body.disk_gb;
    applyRoleLabels(b, body);
    b.workMachine = false;
    setStatusLater(b, "running", BOOT_MS);
    console.log(`created server #${id} ${b.name} (${b.computerRole}; ${b.comment})`);
    return (send(res, 201, fleetJson(b)), true);
  }
  const m = p.match(/^\/api\/v1\/boxes\/(\d+)(\/[a-z]+)?$/);
  if (!m) return false;
  const b = fleet.get(Number(m[1]));
  if (!b) return false;
  const sub = m[2] || "";
  if (req.method === "PATCH" && sub === "") {
    const body = await readBody(req);
    applyRoleLabels(b, body);
    console.log(`box #${b.id} role → ${b.computerRole}, comment → ${b.comment}`);
    return (send(res, 200, fleetJson(b)), true);
  }
  if (b.id === BOX_ID) return false; // "my-computer" keeps the single-box mock below
  if (GET && sub === "/apps") return (send(res, 200, { apps: SERVER_APPS.get(b.id) ?? [] }), true);
  if (GET && sub === "/metrics") {
    if (b.status !== "running")
      return (send(res, 409, { ok: false, error: "box is not running" }), true);
    return (
      send(res, 200, {
        ok: true,
        box_id: b.id,
        live: true,
        uptime_s: 3 * 86400 + 7200,
        cpu: { usage_pct: 12 + Math.random() * 20, vcpu: b.vcpu },
        mem: { used_mb: Math.round(b.ramMb * 0.46), limit_mb: b.ramMb },
        disk: { used_gb: b.diskGb * 0.38, total_gb: b.diskGb },
        history: [],
      }),
      true
    );
  }
  if (GET && sub === "/applogs") {
    const t = Date.now();
    const lines = Array.from({ length: 24 }, (_, i) => {
      const at = new Date(t - (24 - i) * 37_000).toISOString().replace("T", " ").slice(0, 19);
      return {
        line: `${at} wg-easy[412]: peer ${["phone", "laptop", "tablet"][i % 3]} handshake ok`,
      };
    });
    return (send(res, 200, { ok: true, source: "docker", lines, truncated: false }), true);
  }
  return false;
}

async function handleFleet(req, res, url) {
  const p = url.pathname;
  // Test knob: POST /__mock/address-delay?ms=250000 — how long the next
  // created box's address stays unrouted.
  if (p === "/__mock/address-delay" && req.method === "POST") {
    ADDRESS_DELAY_MS = Number(url.searchParams.get("ms") || ADDRESS_DELAY_MS);
    return (send(res, 200, { addressDelayMs: ADDRESS_DELAY_MS }), true);
  }
  if (p === "/api/v1/boxes" && req.method === "GET") {
    return (send(res, 200, { boxes: [...fleet.values()].map(fleetJson) }), true);
  }
  if (p === "/api/v1/work/image") {
    return (send(res, 200, { image_id: 135, name: "uno-work v9.3", state: "ready" }), true);
  }
  const launch = p.match(/^\/api\/v1\/images\/(\d+)\/launch$/);
  if (launch && req.method === "POST") {
    const body = await readBody(req);
    const id = nextBoxId++;
    const b = fleetBox(
      id,
      body.name || `box-${id}`,
      "provisioning",
      parseDaemon(process.env.MOCK_NEW_BOX_DAEMON),
      nextEdgePort++,
    );
    b.ramMb = body.ram_mb || 2048;
    b.vcpu = body.vcpu || 1;
    b.diskGb = body.disk_gb || 10;
    setStatusLater(b, "running", BOOT_MS);
    b.addressReadyAt = Date.now() + BOOT_MS + ADDRESS_DELAY_MS;
    console.log(
      `launched box #${id} ${b.name}; address routed in ${(BOOT_MS + ADDRESS_DELAY_MS) / 1000}s`,
    );
    return (send(res, 201, fleetJson(b)), true);
  }
  const m = p.match(/^\/api\/v1\/boxes\/(\d+)(\/.*)?$/);
  if (!m) return false;
  const b = fleet.get(Number(m[1]));
  if (!b) return (send(res, 404, { error: "NOT_FOUND" }), true);
  if (
    b.id === BOX_ID &&
    !["/sleep", "/wake", "/stop", "/start", "/work/session"].includes(m[2] || "")
  ) {
    return false; // metrics, apps, logs of "my-computer": the single-box mock below
  }
  const sub = m[2] || "";
  if (sub === "") return (send(res, 200, fleetJson(b)), true);
  if (sub === "/ports" && req.method === "GET") {
    return (send(res, 200, { ports: b.edgePort ? [{ id: 1, internal_port: 80 }] : [] }), true);
  }
  if (sub === "/ports" && req.method === "POST")
    return (send(res, 201, { id: 2, internal_port: 80 }), true);
  if (req.method === "POST" && ["/sleep", "/stop"].includes(sub)) {
    b.status = sub === "/sleep" ? "sleeping" : "stopped";
    console.log(`box #${b.id} ${b.name} → ${b.status}`);
    return (send(res, 200, { status: "ok", box_state: b.status }), true);
  }
  if (req.method === "POST" && ["/wake", "/start"].includes(sub)) {
    if (b.status !== "running") {
      b.status = "starting";
      setStatusLater(b, "running", WAKE_MS);
    }
    return (send(res, 200, { status: "ok", box_state: b.status }), true);
  }
  if (sub === "/work/session" && req.method === "POST") {
    if (b.status === "error") {
      return (
        send(res, 409, {
          error: `NETWORK_NOT_READY: box ${b.id} hostname is not published yet — retry shortly`,
        }),
        true
      );
    }
    if (!b.daemon) {
      return (
        send(res, 409, {
          error: `uno work daemon is not installed on box ${b.id}: run curl -fsSL https://console.uno4.dev/cli/work/install.sh | sudo bash`,
        }),
        true
      );
    }
    if (b.status !== "running")
      return (send(res, 409, { error: `box ${b.id} is not running` }), true);
    try {
      const issued = await mintPairing(b);
      return (
        send(res, 200, {
          url: issued.pairUrl,
          hostname: `127.0.0.1:${b.edgePort}`,
          expires_at: issued.expiresAt ?? null,
        }),
        true
      );
    } catch (cause) {
      return (send(res, 500, { error: `pairing failed: ${cause?.message ?? cause}` }), true);
    }
  }
  return false;
}

if (SCENARIO === "fleet") initFleet();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  console.log(`${req.method} ${url.pathname}${url.search}`);

  // "Sign in with Uno" for the desktop app: the console page bounces straight
  // back to the app's loopback with a code; the code is exchanged for a token.
  if (path === "/work/desktop") {
    const port = url.searchParams.get("port");
    const state = url.searchParams.get("state");
    res.writeHead(302, {
      Location: `http://127.0.0.1:${port}/uno-callback?code=mock-code&state=${encodeURIComponent(state ?? "")}`,
    });
    return res.end();
  }
  if (path === "/api/v1/work/desktop-token" && req.method === "POST") {
    return send(res, 200, {
      token: "uno_usr_mock_desktop",
      user: { id: 85, email: "demo@uno4.dev", username: "demo" },
    });
  }
  if (!req.headers.authorization?.startsWith("Bearer ")) {
    return send(res, 401, { error: "UNAUTHORIZED" });
  }
  if (SCENARIO === "not-deployed" && NOT_DEPLOYED.test(path)) return notFound(res);
  if (SCENARIO === "fleet" && (await handleMyUno(req, res, url))) return;
  if (SCENARIO === "fleet" && (await handleFleet(req, res, url))) return;

  if (path === "/auth/me") {
    return send(res, 200, {
      id: 85,
      username: "demo",
      // Telegram's first name (oauth_connections.provider_first_name): Home
      // greets by it ("Good morning, Mikhail").
      first_name: "Mikhail",
      telegram_username: "demo_tg",
      email: "demo@uno4.dev",
      balance: 42.5,
      llm_balance: 3,
      role: "user",
    });
  }
  // The daemon mints its narrow Uno AI key from the account key it was given.
  if (path === "/llm/keys" && req.method === "POST") {
    return send(res, 200, { id: 1, key: "unollm_mock_machine_key", label: "mock" });
  }
  // The Uno AI gateway's balance for the machine key (Home's "Uno AI spend"):
  // point the daemon here with UNO_WORK_APP_GATEWAY_URL=http://127.0.0.1:8091/v1.
  // The running total grows a cent a minute so the widget has something to count.
  if (path === "/v1/credits") {
    const minutes = (Date.now() - MOCK_STARTED_AT) / 60_000;
    return send(res, 200, {
      llm_balance: Math.max(0, 119.37 - minutes * 0.01),
      total_spent: Number(process.env.MOCK_AI_TOTAL_SPENT || 48.2) + minutes * 0.01,
      total_requests: 1200,
    });
  }
  if (path === "/api/v1/boxes") return send(res, 200, { boxes: [box()] });
  if (path === "/api/v1/apps/templates") return send(res, 200, { templates: TEMPLATES });
  if (path === "/api/v1/box-subscription") return send(res, 200, subscription());
  if (path === "/api/v1/git/services") return send(res, 200, { services: SERVICES });

  const dm = path.match(/^\/api\/v1\/deployments\/(\d+)\/logs$/);
  if (dm) {
    const dep = DEPLOYMENTS.get(Number(dm[1]));
    if (!dep) return send(res, 404, { error: "NOT_FOUND" });
    const after = Number(url.searchParams.get("after_seq") || 0);
    return send(res, 200, {
      status: dep.status,
      done: dep.done,
      logs: dep.lines.filter((l) => l.seq > after),
    });
  }

  const m = path.match(/^\/api\/v1\/boxes\/(\d+)(\/.*)?$/);
  if (m) {
    if (Number(m[1]) !== BOX_ID) return send(res, 404, { error: "NOT_FOUND" });
    const sub = m[2] || "";
    if (sub === "") return send(res, 200, box());
    if (sub === "/boost" && (req.method === "POST" || req.method === "DELETE")) {
      const body = req.method === "POST" ? await readBody(req) : {};
      const [code, answer] =
        req.method === "POST" ? boostStart(Number(body.hours ?? 1)) : boostStop();
      if (code >= 400) console.log(`boost refused: ${answer.error}`);
      return send(res, code, answer);
    }
    if (sub === "/resize" && req.method === "POST") {
      const body = await readBody(req);
      const want = {
        ram_mb: Number(body.ram_mb) || SHAPE.ram_mb,
        vcpu: Number(body.vcpu) || SHAPE.vcpu,
        disk_gb: Number(body.disk_gb) || SHAPE.disk_gb,
      };
      const refusal = resizeRefusal(want);
      if (refusal) {
        console.log(`resize refused: ${refusal}`, want);
        return send(res, refusal === "DISK_SHRINK_UNSUPPORTED" ? 400 : 409, { error: refusal });
      }
      Object.assign(SHAPE, want);
      console.log("resized", SHAPE);
      return send(res, 200, box());
    }
    if (sub === "/ports" && req.method === "POST") {
      // Same contract as prod (POST /boxes/{id}/ports): a public forward on the
      // next free external port; no URL in the answer.
      const body = await readBody(req);
      const port = Number(body.port ?? body.internal_port);
      if (!port) return send(res, 400, { error: "INVALID_REQUEST" });
      const forward = {
        id: nextPortId++,
        internal_port: port,
        external_port: 42000 + nextPortId,
        protocol: body.protocol || "tcp",
        visibility: body.visibility || "public",
        state: "applied",
      };
      PORTS.push(forward);
      console.log(`published port ${port}/${forward.protocol} → ${forward.external_port}`);
      return send(res, 201, forward);
    }
    const portMatch = sub.match(/^\/ports\/(\d+)$/);
    if (portMatch && req.method === "DELETE") {
      const index = PORTS.findIndex((p) => p.id === Number(portMatch[1]));
      if (index === -1) return send(res, 404, { error: "NOT_FOUND" });
      const [removed] = PORTS.splice(index, 1);
      console.log(`removed forward of port ${removed.internal_port}`);
      return send(res, 200, { status: "deleted" });
    }
    if (sub === "/ports") return send(res, 200, { ports: PORTS });
    if (req.method === "POST" && ["/sleep", "/wake", "/stop", "/start"].includes(sub)) {
      statusOverride = sub === "/sleep" ? "sleeping" : sub === "/stop" ? "stopped" : "running";
      if (statusOverride === "running") startedAtOverride = iso(new Date());
      return send(res, 200, { status: "ok", box_state: statusOverride });
    }
    if (sub === "/metrics") {
      if (SCENARIO === "node-down") return send(res, 502, { ok: false, error: "node unreachable" });
      if (status() !== "running") return send(res, 200, { ok: true, box_id: BOX_ID, live: false });
      return send(res, 200, metrics());
    }
    if (sub === "/applogs") {
      if (status() !== "running")
        return send(res, 200, { ok: false, error: "guest agent not running" });
      return send(res, 200, applogs(Number(url.searchParams.get("tail") || 200)));
    }
    if (req.method === "GET" && sub === "/apps") {
      return send(res, 200, { apps: [...APP_CARDS.values()] });
    }
    // Sign in with Uno: a one-time link (here — straight to the app) and sharing.
    const openMatch = sub.match(/^\/apps\/(\d+)\/open$/);
    if (openMatch && req.method === "POST") {
      const card = APP_CARDS.get(Number(openMatch[1]));
      if (!card) return send(res, 404, { error: "NOT_FOUND" });
      const signedIn = Boolean(card.sso);
      return send(res, 200, {
        url: signedIn ? `${card.url}/?uno-signed-in=1` : card.url,
        app_url: card.url,
        signed_in: signedIn,
        sso: card.sso ?? null,
      });
    }
    const accessMatch = sub.match(/^\/apps\/(\d+)\/access(?:\/(\d+))?$/);
    if (accessMatch) {
      const card = APP_CARDS.get(Number(accessMatch[1]));
      if (!card) return send(res, 404, { error: "NOT_FOUND" });
      if (!card.sso) return send(res, 409, { error: "APP_NO_SSO" });
      card.people ??= [{ user_id: 501, username: "anna", email: "anna@example.com" }];
      if (req.method === "POST") {
        const body = await readBody(req);
        const login = String(body.login || "").toLowerCase();
        if (!login.includes("@")) return send(res, 404, { error: "USER_NOT_FOUND" });
        if (!card.people.some((p) => p.email === login)) {
          card.people.push({
            user_id: 500 + card.people.length + 1,
            username: login,
            email: login,
          });
        }
      } else if (req.method === "DELETE" && accessMatch[2]) {
        card.people = card.people.filter((p) => p.user_id !== Number(accessMatch[2]));
      }
      card.shared_with = card.people.length;
      return send(res, req.method === "POST" ? 201 : 200, {
        people: card.people,
        sso: card.sso,
        sso_ready: true,
      });
    }
    const appMatch = sub.match(/^\/apps\/(\d+)$/);
    if (appMatch && (req.method === "DELETE" || req.method === "PATCH")) {
      if (process.env.MOCK_REMOVE === "old") {
        res.writeHead(405, { "Content-Type": "text/plain" });
        return res.end("Method Not Allowed\n");
      }
      const deploymentId = Number(appMatch[1]);
      const card = APP_CARDS.get(deploymentId);
      if (!card) return send(res, 404, { error: "NOT_FOUND", detail: "no such app" });
      if (req.method === "PATCH") {
        const body = await readBody(req);
        if (!card.ai_key) return send(res, 409, { error: "APP_NO_AI_KEY" });
        const limit = body.ai_limit_usd;
        card.ai_key = { ...card.ai_key, limit_usd: typeof limit === "number" ? limit : null };
        console.log(`AI limit of ${card.name} → ${card.ai_key.limit_usd ?? "none"}`);
        return send(res, 200, { ai_key: card.ai_key });
      }
      const dep = DEPLOYMENTS.get(deploymentId);
      if (dep && !dep.done) {
        return send(res, 409, { error: "APP_BUSY", detail: "the install is still running" });
      }
      const deleteData = url.searchParams.get("delete_data") === "true";
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (process.env.MOCK_REMOVE === "fail") {
        return send(res, 502, {
          error: "APP_REMOVE_FAILED",
          detail: "The app's containers didn't stop in time",
        });
      }
      APP_CARDS.delete(deploymentId);
      const index = SERVICES.findIndex((sv) => sv.last_deployment_id === deploymentId);
      if (index !== -1) SERVICES.splice(index, 1);
      console.log(`removed ${card.name} (data ${deleteData ? "deleted" : "kept"})`);
      return send(res, 200, {
        removed: true,
        template_id: card.template_id,
        data_deleted: deleteData,
      });
    }
    if (req.method === "POST" && sub === "/apps") {
      const body = await readBody(req);
      const template = TEMPLATES.find((t) => t.id === body.template_id);
      if (!template) return send(res, 404, { error: "TEMPLATE_NOT_FOUND" });
      const dep = startInstall(template, body.env);
      return send(res, 202, { deployment_id: dep.id, status: dep.status });
    }
  }
  return notFound(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `mock control plane on http://127.0.0.1:${PORT} — scenario: ${SCENARIO}, box #${BOX_ID}`,
  );
});
