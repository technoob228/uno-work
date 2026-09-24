#!/usr/bin/env node
/*
 * Local stand-in for app.uno4.work serving the web lite build: the static
 * dist-lite with SPA fallback (what fishcode does with BOX_WORK_LITE_DIR) and
 * the same-origin account API under /_account/* with fixture data.
 * Zero dependencies.
 *
 *   bun run build:lite
 *   node scripts/lite-mock-server.mjs free     # :8093 — no plan, two sites
 *   node scripts/lite-mock-server.mjs small    # a Small server with apps
 *   node scripts/lite-mock-server.mjs plus     # Plus, no Uno Work machine yet
 *
 * Env: PORT (default 8093), LITE_DIST (default ./dist-lite).
 *
 * LITE_FIXTURES=<dir> answers GETs from recorded responses instead: the file
 * for /api/v1/work/plans is <dir>/_api_v1_work_plans.json (a trailing
 * "<http_code> <time>s" line from curl -w is ignored). Missing files answer
 * as an empty account (no computers, no sites). Scenario "free" answers the
 * subscription with 404 whatever the fixtures say.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8093);
const SCENARIO = process.argv[2] || process.env.LITE_SCENARIO || "free";
const DIST = path.resolve(process.env.LITE_DIST || path.join(here, "..", "dist-lite"));

const iso = (d) => d.toISOString();
const minsAgo = (m) => new Date(Date.now() - m * 60_000);

// The ladder of 24.09: Small 1 core, Plus 4, Pro 16, Max 32.
const PLANS = [
  ["small", "Small", 5, 15, 20, 2, 1, 20, 25],
  ["plus", "Plus", 20, 30, 50, 8, 4, 60, 100],
  ["pro-v2", "Pro", 70, 50, 120, 32, 16, 160, 300],
  ["max", "Max", 200, 100, 300, 64, 32, 320, 1024],
].flatMap(([slug, name, compute, ai, aiPrice, ramGb, vcpu, disk, s3]) =>
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
    disk_gb: disk,
    s3_gb: s3,
    boost_hours: 10,
    cloud_work: slug !== "small",
    legacy: false,
  })),
);

const PLAN = { free: null, small: "small", plus: "plus-ai" }[SCENARIO] ?? null;
const MY_PLAN = PLAN ? PLANS.find((p) => p.slug === PLAN) : null;

const BOXES =
  SCENARIO === "small"
    ? [
        {
          id: 301,
          name: "vpn",
          status: "running",
          ram_mb: 2048,
          vcpu: 1,
          disk_gb: 20,
          work_machine: false,
          computer_role: "server",
          comment: "VPN and a Telegram bot",
          always_on: true,
          started_at: iso(minsAgo(60 * 50)),
          created_at: iso(minsAgo(60 * 24 * 30)),
          url: "https://vpn-301.app.uno4.dev",
        },
      ]
    : [];

const APPS = {
  301: [
    {
      deployment_id: 931,
      template_id: "wg-easy",
      name: "WireGuard VPN",
      icon: "🛡️",
      status: "running",
      url: "https://wg-301.app.uno4.dev",
    },
  ],
};

const SITES = [
  { slug: "portfolio-anna", size_bytes: 3_100_000, files_count: 18, updated_at: iso(minsAgo(90)) },
  {
    slug: "landing-caba",
    size_bytes: 18_700_000,
    files_count: 64,
    custom_domain: "caba.example.com",
    updated_at: iso(minsAgo(60 * 24 * 2)),
  },
].map((d, i) => ({ id: i + 1, url: `https://${d.slug}.uno4.dev`, has_password: false, ...d }));

function subscription() {
  if (!MY_PLAN) return null;
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
      carry_usd: 0,
    },
    usage: {
      running_ram_mb: BOXES.reduce((s, b) => s + (b.status === "running" ? b.ram_mb : 0), 0),
      running_vcpu: BOXES.reduce((s, b) => s + (b.status === "running" ? b.vcpu : 0), 0),
      disk_gb_used: BOXES.reduce((s, b) => s + b.disk_gb, 0) * 0.4,
      box_count: BOXES.length,
    },
  };
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const FIXTURES = process.env.LITE_FIXTURES ? path.resolve(process.env.LITE_FIXTURES) : null;
const EMPTY = {
  "/api/v1/boxes": { boxes: [] },
  "/api/v1/work/sites": { deploys: [], storage_used_bytes: 0, storage_limit_bytes: 0 },
  "/pay/history": { success: true, payments: [] },
  "/pay/spending": { success: true, spending: [] },
};

function recorded(p) {
  const file = path.join(FIXTURES, `${p.replace(/\//g, "_")}.json`);
  if (!existsSync(file)) return EMPTY[p] ?? null;
  const lines = readFileSync(file, "utf8").trimEnd().split("\n");
  if (/^\d{3} [\d.]+s$/.test(lines.at(-1)?.trim() ?? "")) lines.pop();
  return JSON.parse(lines.join("\n"));
}

function account(req, res, p) {
  if (req.headers["x-uno-account"] !== "1") return send(res, 403, { error: "CSRF" });
  const GET = req.method === "GET";
  if (FIXTURES && GET) {
    if (SCENARIO === "free" && p === "/api/v1/box-subscription") {
      return send(res, 404, { error: "NO_SUBSCRIPTION" });
    }
    const body = recorded(p);
    return body === null
      ? send(res, 404, { error: "NOT_RECORDED", path: p })
      : send(res, 200, body);
  }
  if (GET && p === "/auth/me") {
    return send(res, 200, {
      id: 85,
      username: `demo-${SCENARIO}`,
      email: `${SCENARIO}@example.com`,
      balance: SCENARIO === "free" ? 0 : 12.5,
      llm_balance: 0,
      role: "user",
    });
  }
  if (GET && p === "/api/v1/box-subscription") {
    const sub = subscription();
    return sub ? send(res, 200, sub) : send(res, 404, { error: "NO_SUBSCRIPTION" });
  }
  if (GET && p === "/api/v1/work/plans") return send(res, 200, { plans: PLANS, plans_v2: true });
  if (GET && p === "/api/v1/boxes") return send(res, 200, { boxes: BOXES });
  if (GET && p === "/api/v1/work/sites") {
    return send(res, 200, {
      deploys: SITES,
      storage_used_bytes: SITES.reduce((s, d) => s + d.size_bytes, 0),
      storage_limit_bytes: 1024 ** 3,
    });
  }
  if (GET && p === "/api/v1/buckets") {
    const quota = (MY_PLAN?.s3_gb ?? 5) * 1024 ** 3;
    return send(res, 200, {
      buckets: [{ id: 7, name: "files", used_bytes: 1.2 * 1024 ** 3, quota_bytes: 0 }],
      storage: { used_bytes: 1.2 * 1024 ** 3, quota_bytes: quota, over_quota: false },
    });
  }
  if (GET && p === "/pay/history") return send(res, 200, { success: true, payments: [] });
  if (GET && p === "/pay/spending") return send(res, 200, { success: true, spending: [] });
  const m = p.match(/^\/api\/v1\/boxes\/(\d+)(\/[a-z]+)?$/);
  const box = m ? BOXES.find((b) => b.id === Number(m[1])) : null;
  if (box) {
    const sub = m[2] ?? "";
    if (GET && sub === "") return send(res, 200, box);
    if (GET && sub === "/apps") return send(res, 200, { apps: APPS[box.id] ?? [] });
    if (GET && sub === "/metrics") {
      return send(res, 200, {
        live: true,
        cpu: { usage_pct: 7 },
        mem: { used_mb: 610, limit_mb: box.ram_mb },
        disk: { used_gb: 4.2, total_gb: box.disk_gb },
        uptime_s: 180_000,
      });
    }
    if (GET && sub === "/applogs") {
      return send(res, 200, { lines: [{ line: "wg-easy: listening on :51821" }] });
    }
  }
  return send(res, 404, { error: "NOT_IN_MOCK", path: p });
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

function serveStatic(res, pathname) {
  let file = path.join(DIST, decodeURIComponent(pathname));
  if (!file.startsWith(DIST)) file = path.join(DIST, "index.html");
  if (!existsSync(file) || !statSync(file).isFile()) file = path.join(DIST, "index.html");
  res.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/_account/")) {
      return account(req, res, url.pathname.slice("/_account".length));
    }
    if (url.pathname === "/logout") {
      res.writeHead(302, { Location: "/" });
      return res.end();
    }
    return serveStatic(res, url.pathname);
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`web lite mock on http://127.0.0.1:${PORT} — scenario: ${SCENARIO}, dist: ${DIST}`);
  });
