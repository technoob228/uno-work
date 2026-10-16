// `uno` — Uno Work from a shell: this computer's resources and the person's
// Uno Drive (cloud storage) for agents (Codex, OpenCode, Claude Code via Bash)
// and scripts. Zero dependencies, Node >= 18.
//
// The Uno Work daemon keeps this file at ~/.uno/sdk/js/uno-cli.mjs and the
// `uno` launcher at ~/.uno/sdk/bin/uno (on PATH for agents). Every command is
// one call of the chat's `uno-work` MCP tools over the local bridge
// (UNO_WORK_BRIDGE_URL + UNO_WORK_BRIDGE_TOKEN, scoped to the chat): no cloud
// keys on the machine, and the person's Allow applies exactly as for the tools.

import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  accessSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { constants as osConstants, homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const MCP_PATH = "/api/uno-work/mcp";
export const GUIDE_PATH = "/api/uno-work/guide";

/** A plain call: 10 min covers a pending Allow (the daemon waits 5 min). */
export const CALL_TIMEOUT_MS = 10 * 60_000;
/** Copies to/from Uno Drive carry files of any size. */
export const TRANSFER_TIMEOUT_MS = 60 * 60_000;
/** After this long without an answer, say we may be waiting for the person. */
const WAITING_HINT_MS = 4_000;

export const USAGE = `uno — Uno Work from the shell (this computer and Uno Drive, the person's cloud storage)

  uno status [--json]                    CPU, memory, disk and what uses them; warnings
  uno cleanup [--apply] [--json]         Show what can be freed (build and package caches); --apply frees it
  uno drive ls [folder] [--json]         List a Uno Drive folder (default: the top)
  uno drive find [words...] [--json]     Find files by name (no words: the newest); --smart asks AI, -n N
  uno drive put <path...> [--to Folder/] Copy files or folders from this computer to Uno Drive
  uno drive get <key...> [--to ~/dir]    Copy Uno Drive files here (default ~/Uploads/YYYY-MM)
  uno drive link <key> [--days N]        A download link anyone can open (default 7 days, max 90)
  uno guide [topic]                      How-to for Uno Work (storage, apps, app-sdk, ...)
  uno help

Keys are Uno Drive paths as "uno drive ls/find" prints them, e.g. Reports/q3.pdf.
Commands that change things may wait for the person's Allow in Uno Work.
Other commands go to the Uno API CLI when it is installed.`;

/** Where the Uno API CLI (`uno boxes|git|servers ...`) is documented. */
export const UNO_API_CLI_HINT =
  "Uno API commands (boxes, git, servers…) need the Uno CLI: see https://console.uno.place/llms.txt";
/** Set for a delegated run, so a wrapper that calls us back can't loop. */
const DELEGATED_ENV = "UNO_SDK_CLI_DELEGATED";
/** What our own launcher (~/.uno/sdk/bin/uno, sdkFiles.ts) contains. */
const LAUNCHER_MARKER = 'import("../js/uno-cli.mjs")';

const NO_URL = "Run this inside an Uno Work chat or app terminal (UNO_WORK_BRIDGE_URL is not set).";
const NO_TOKEN =
  "Run this inside an Uno Work chat or app terminal (UNO_WORK_BRIDGE_TOKEN is not set).";

// ── Parsing: argv → what to call (pure, no I/O) ─────────────────────────

/**
 * @typedef {{ name: string, value: boolean, short?: string }} FlagSpec
 *   value: true when the flag takes a value (`--to X` / `--to=X`).
 */

/**
 * Split argv into positionals and the flags `allowed` names.
 * @param {string[]} argv
 * @param {FlagSpec[]} allowed
 */
function splitArgs(argv, allowed) {
  /** @type {string[]} */
  const positionals = [];
  /** @type {Record<string, string | true>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = /** @type {string} */ (argv[index]);
    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [rawName, inline] = arg.startsWith("--")
      ? [
          arg.slice(2).split("=")[0] ?? "",
          arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined,
        ]
      : [arg.slice(1), undefined];
    const spec = allowed.find((flag) =>
      arg.startsWith("--") ? flag.name === rawName : flag.short === rawName,
    );
    if (!spec) throw new UsageError(`Unknown option ${arg}.`);
    if (!spec.value) {
      if (inline !== undefined) throw new UsageError(`--${spec.name} takes no value.`);
      flags[spec.name] = true;
      continue;
    }
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      throw new UsageError(`--${spec.name} needs a value.`);
    }
    if (inline === undefined) index += 1;
    flags[spec.name] = value;
  }
  return { positionals, flags };
}

class UsageError extends Error {}

const JSON_FLAG = { name: "json", value: false };

/**
 * A path on this computer as the daemon needs it: absolute (the daemon's
 * own default folder is the chat's, not this shell's), `~` expanded.
 * @param {string} raw
 * @param {{ cwd: string, home: string }} where
 */
export function absolutePath(raw, where) {
  const value = raw.trim();
  if (value === "~") return where.home;
  if (value.startsWith("~/")) return path.join(where.home, value.slice(2));
  return path.resolve(where.cwd, value);
}

/** A Uno Drive key or folder as the person writes it: no leading "/". */
function driveKey(/** @type {string} */ raw) {
  return raw.trim().replace(/^\/+/, "");
}

function positiveInt(/** @type {string | true | undefined} */ raw, /** @type {string} */ flag) {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`${flag} must be a whole number of 1 or more.`);
  }
  return value;
}

/**
 * @typedef {"status" | "cleanup" | "find" | "put" | "get" | "link" | "raw"} Render
 * @typedef {{ kind: "help" }
 *   | { kind: "usage-error", message: string }
 *   | { kind: "call", tool: string, args: Record<string, unknown>, json: boolean,
 *       render: Render, timeoutMs: number, mayAsk: boolean }
 *   | { kind: "drive-ls", folder: string, json: boolean }
 *   | { kind: "guide", topic: string }
 *   | { kind: "delegate", argv: string[] }} Plan
 */

/**
 * What `uno <argv>` does, without doing it.
 * @param {string[]} argv
 * @param {{ cwd: string, home: string }} where
 * @returns {Plan}
 */
export function planCommand(argv, where) {
  try {
    return plan(argv, where);
  } catch (error) {
    if (error instanceof UsageError) return { kind: "usage-error", message: error.message };
    throw error;
  }
}

/** First words this command answers itself; any other goes to the Uno API CLI. */
const OWN_COMMANDS = new Set(["status", "cleanup", "drive", "guide"]);

/** @returns {Plan} */
function plan(/** @type {string[]} */ argv, /** @type {{ cwd: string, home: string }} */ where) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    return { kind: "help" };
  }
  // Help flags inside our own commands only: `uno boxes create --help` is the API CLI's.
  if (OWN_COMMANDS.has(command) && (rest.includes("--help") || rest.includes("-h"))) {
    return { kind: "help" };
  }
  /** @param {Omit<Extract<Plan, { kind: "call" }>, "kind" | "timeoutMs" | "mayAsk"> & { timeoutMs?: number, mayAsk?: boolean }} call */
  const callPlan = (call) => /** @type {Plan} */ ({
    kind: "call",
    timeoutMs: CALL_TIMEOUT_MS,
    mayAsk: false,
    ...call,
  });

  switch (command) {
    case "status": {
      const { positionals, flags } = splitArgs(rest, [JSON_FLAG]);
      noPositionals(positionals, "uno status");
      return callPlan({ tool: "computer_status", args: {}, json: !!flags.json, render: "status" });
    }
    case "cleanup": {
      const { positionals, flags } = splitArgs(rest, [{ name: "apply", value: false }, JSON_FLAG]);
      noPositionals(positionals, "uno cleanup");
      return callPlan({
        tool: "computer_cleanup",
        args: flags.apply ? { apply: true } : {},
        json: !!flags.json,
        render: "cleanup",
        mayAsk: !!flags.apply,
      });
    }
    case "guide": {
      const { positionals } = splitArgs(rest, []);
      if (positionals.length > 1) throw new UsageError("Usage: uno guide [topic]");
      return { kind: "guide", topic: positionals[0] ?? "overview" };
    }
    case "drive":
      return planDrive(rest, where, callPlan);
    default:
      // Not ours: the Uno API CLI's (`uno boxes list`, `uno git ...`), if installed.
      return { kind: "delegate", argv: [...argv] };
  }
}

/**
 * @param {string[]} argv
 * @param {{ cwd: string, home: string }} where
 * @param {(call: any) => Plan} callPlan
 * @returns {Plan}
 */
function planDrive(argv, where, callPlan) {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "ls":
    case "list": {
      const { positionals, flags } = splitArgs(rest, [JSON_FLAG]);
      if (positionals.length > 1) throw new UsageError("Usage: uno drive ls [folder]");
      const raw = driveKey(positionals[0] ?? "");
      return {
        kind: "drive-ls",
        folder: raw && !raw.endsWith("/") ? `${raw}/` : raw,
        json: !!flags.json,
      };
    }
    case "find": {
      const { positionals, flags } = splitArgs(rest, [
        { name: "smart", value: false },
        { name: "limit", value: true, short: "n" },
        JSON_FLAG,
      ]);
      const query = positionals.join(" ").trim();
      const limit = positiveInt(flags.limit, "-n");
      return callPlan({
        tool: "drive_find",
        args: {
          ...(query ? { query } : {}),
          ...(flags.smart ? { smart: true } : {}),
          ...(limit ? { limit: Math.min(limit, 200) } : {}),
        },
        json: !!flags.json,
        render: "find",
      });
    }
    case "put": {
      const { positionals, flags } = splitArgs(rest, [{ name: "to", value: true }, JSON_FLAG]);
      if (positionals.length === 0) {
        throw new UsageError("Usage: uno drive put <path...> [--to Folder/]");
      }
      const folder = typeof flags.to === "string" ? driveKey(flags.to) : "";
      return callPlan({
        tool: "drive_save",
        args: {
          paths: positionals.map((item) => absolutePath(item, where)),
          ...(folder ? { folder } : {}),
        },
        json: !!flags.json,
        render: "put",
        timeoutMs: TRANSFER_TIMEOUT_MS,
        mayAsk: true,
      });
    }
    case "get": {
      const { positionals, flags } = splitArgs(rest, [{ name: "to", value: true }, JSON_FLAG]);
      if (positionals.length === 0) {
        throw new UsageError("Usage: uno drive get <key...> [--to ~/dir]");
      }
      return callPlan({
        tool: "drive_get",
        args: {
          keys: positionals.map(driveKey),
          ...(typeof flags.to === "string" ? { folder: absolutePath(flags.to, where) } : {}),
        },
        json: !!flags.json,
        render: "get",
        timeoutMs: TRANSFER_TIMEOUT_MS,
        mayAsk: true,
      });
    }
    case "link":
    case "share": {
      const { positionals, flags } = splitArgs(rest, [{ name: "days", value: true }, JSON_FLAG]);
      if (positionals.length !== 1) throw new UsageError("Usage: uno drive link <key> [--days N]");
      const days = positiveInt(flags.days, "--days");
      if (days !== undefined && days > 90) throw new UsageError("--days can be at most 90.");
      return callPlan({
        tool: "drive_share_link",
        args: {
          key: driveKey(/** @type {string} */ (positionals[0])),
          ...(days ? { expiresInHours: days * 24 } : {}),
        },
        json: !!flags.json,
        render: "link",
        mayAsk: true,
      });
    }
    case undefined:
      throw new UsageError("Usage: uno drive ls|find|put|get|link ... (uno help)");
    default:
      throw new UsageError(`Unknown command "drive ${sub}". Run: uno help`);
  }
}

function noPositionals(/** @type {string[]} */ positionals, /** @type {string} */ usage) {
  if (positionals.length > 0)
    throw new UsageError(`Usage: ${usage} (unexpected "${positionals[0]}")`);
}

// ── Bridge: one HTTP call to the Work daemon ────────────────────────────

/** A failure to print as is (exit 1). */
export class UnoCliError extends Error {}

/**
 * POST/GET over node:http — not fetch: undici gives up after 5 min without
 * response headers, and a call waiting for the person's Allow can take longer.
 * @param {{ url: string, method: "GET" | "POST", token: string, body?: unknown, timeoutMs: number }} input
 * @returns {Promise<{ status: number, text: string }>}
 */
function request(input) {
  const url = new URL(input.url);
  const transport = url.protocol === "https:" ? https : http;
  const payload = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: input.method,
        headers: {
          authorization: `Bearer ${input.token}`,
          accept: "application/json, text/plain, text/markdown",
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        res.setEncoding("utf8");
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
        res.on("error", reject);
      },
    );
    req.setTimeout(input.timeoutMs, () => {
      req.destroy(
        new UnoCliError(
          `Uno Work didn't answer in ${Math.round(input.timeoutMs / 60_000)} min. If it asked the person to Allow this, it may still be waiting.`,
        ),
      );
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** @param {NodeJS.ProcessEnv} env */
export function bridgeFromEnv(env) {
  const url = env.UNO_WORK_BRIDGE_URL?.trim();
  if (!url) throw new UnoCliError(NO_URL);
  const token = env.UNO_WORK_BRIDGE_TOKEN?.trim();
  if (!token) throw new UnoCliError(NO_TOKEN);
  return { url: url.replace(/\/+$/, ""), token };
}

/** @param {unknown} error */
function describeNetworkError(error, /** @type {string} */ url) {
  if (error instanceof UnoCliError) return error;
  const code = /** @type {{ code?: string }} */ (error)?.code;
  return new UnoCliError(
    `Can't reach Uno Work at ${url}${code ? ` (${code})` : ""}. Is Uno Work running?`,
  );
}

/**
 * Call one `uno-work` tool. Resolves with the tool's result (parsed JSON when
 * it is JSON), rejects with UnoCliError carrying the tool's own message.
 * @param {{ url: string, token: string }} bridge
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function callTool(bridge, tool, args, options = {}) {
  const response = await request({
    url: `${bridge.url}${MCP_PATH}`,
    method: "POST",
    token: bridge.token,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    },
    timeoutMs: options.timeoutMs ?? CALL_TIMEOUT_MS,
  }).catch((error) => {
    throw describeNetworkError(error, bridge.url);
  });
  /** @type {any} */
  let body = null;
  try {
    body = JSON.parse(response.text);
  } catch {
    // not JSON: reported below
  }
  if (response.status !== 200) {
    const message = body?.message ?? body?.error?.message ?? response.text.trim();
    throw new UnoCliError(message || `Uno Work answered HTTP ${response.status}.`);
  }
  if (body?.error) {
    const message = String(body.error.message ?? "Uno Work refused the call.");
    throw new UnoCliError(
      message.startsWith("Unknown tool:")
        ? `This Uno Work version has no ${tool} yet. Update Uno Work and try again.`
        : message,
    );
  }
  const result = body?.result;
  const text = Array.isArray(result?.content)
    ? result.content
        .filter((/** @type {any} */ part) => part?.type === "text")
        .map((/** @type {any} */ part) => String(part.text))
        .join("\n")
    : "";
  if (result?.isError) throw new UnoCliError(text || `${tool} failed.`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * @param {{ url: string, token: string }} bridge
 * @param {string} topic
 */
export async function fetchGuide(bridge, topic) {
  const response = await request({
    url: `${bridge.url}${GUIDE_PATH}/${encodeURIComponent(topic)}`,
    method: "GET",
    token: bridge.token,
    timeoutMs: 60_000,
  }).catch((error) => {
    throw describeNetworkError(error, bridge.url);
  });
  if (response.status !== 200) {
    throw new UnoCliError(response.text.trim() || `Uno Work answered HTTP ${response.status}.`);
  }
  return response.text;
}

// ── Output ──────────────────────────────────────────────────────────────

export function formatBytes(/** @type {unknown} */ bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "?";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? size : size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

const gbOfMb = (/** @type {unknown} */ mb) => `${(Number(mb) / 1024).toFixed(1)} GB`;
const day = (/** @type {unknown} */ iso) => (typeof iso === "string" ? iso.slice(0, 10) : "");

/** @param {any} status */
export function renderStatus(status) {
  const lines = [];
  const box = status.unoCloudComputer;
  const head = [status.hostname, status.platform].filter(Boolean).join(" · ");
  lines.push(
    box
      ? `${head} · Uno cloud computer ${box.id} (${box.vcpu} vCPU, ${gbOfMb(box.ramMb)} RAM, ${box.diskGb} GB disk)`
      : head,
  );
  if (status.sleep?.note) lines.push(status.sleep.note);
  if (status.cpu) {
    lines.push(
      `CPU     ${status.cpu.usedPct ?? "?"}% of ${status.cpu.count} cores (load ${status.cpu.load1 ?? "?"})`,
    );
  }
  if (status.memoryMb) {
    const memory = status.memoryMb;
    lines.push(
      `Memory  ${gbOfMb(memory.used)} used of ${gbOfMb(memory.total)}, ${gbOfMb(memory.available)} available`,
    );
  }
  for (const disk of status.disks ?? []) {
    const used = disk.totalGb > 0 ? Math.round((1 - disk.freeGb / disk.totalGb) * 100) : 0;
    lines.push(
      `Disk    ${disk.mount}: ${disk.freeGb} GB free of ${disk.totalGb} GB (${used}% used)`,
    );
  }
  const top = (status.topUsers ?? [])
    .slice(0, 5)
    .map((/** @type {any} */ user) => `${user.name} ${gbOfMb(user.memMb)}`);
  if (top.length > 0) lines.push(`Top     ${top.join(" · ")}`);
  if (status.apps) lines.push(`Apps    ${status.apps.total} (${status.apps.running} running)`);
  for (const note of status.notes ?? [])
    lines.push(`! ${typeof note === "string" ? note : JSON.stringify(note)}`);
  return lines.join("\n");
}

/** @param {any[]} files */
function renderFiles(files) {
  if (files.length === 0) return "(no files)";
  return files
    .map((file) => `${file.key}  ${formatBytes(file.size)}  ${day(file.modifiedAt)}`.trimEnd())
    .join("\n");
}

/** @param {any} listing a cloud_list folder listing */
export function renderListing(listing) {
  const lines = [
    ...(listing.folders ?? []).map((/** @type {any} */ folder) => folder.prefix),
    ...(listing.objects ?? []).map(
      (/** @type {any} */ file) =>
        `${file.key}  ${formatBytes(file.size)}  ${day(file.modifiedAt)}`,
    ),
  ];
  if (lines.length === 0) lines.push(`(empty: ${listing.prefix || "Uno Drive"})`);
  if (listing.truncated) lines.push("(more not shown)");
  return lines.join("\n");
}

/**
 * @param {Render} render
 * @param {any} result
 * @param {Record<string, any>} args the tool's arguments
 */
export function renderResult(render, result, args) {
  if (typeof result === "string") return result;
  switch (render) {
    case "status":
      return renderStatus(result);
    case "find":
      return renderFiles(result.files ?? []);
    case "put": {
      const folder = args.folder ? String(args.folder).replace(/\/?$/, "/") : "";
      const lines = [
        `Saved ${result.files} file(s), ${formatBytes(result.bytes)}, to Uno Drive ${folder || "/"}`,
        ...(args.paths ?? []).map(
          (/** @type {string} */ item) => `  ${folder}${path.basename(item)}`,
        ),
      ];
      for (const skip of result.skipped ?? []) lines.push(`skipped ${skip.name}: ${skip.reason}`);
      return lines.join("\n");
    }
    case "get": {
      const lines = [
        `Copied ${result.files} file(s), ${formatBytes(result.bytes)}, to ${result.folder}`,
      ];
      for (const landed of result.paths ?? []) lines.push(`  ${landed}`);
      for (const skip of result.skipped ?? []) lines.push(`skipped ${skip.name}: ${skip.reason}`);
      return lines.join("\n");
    }
    case "link":
      return `${result.url}\n(expires ${result.expiresAt ?? "?"})`;
    default:
      return JSON.stringify(result, null, 2);
  }
}

// ── The other `uno`: the Uno API CLI ────────────────────────────────────

/** @param {string} file */
function realOrNull(file) {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/** Our launcher, a copy of it, or this very file under another name. */
function isOurs(/** @type {string} */ file, /** @type {string | null} */ real) {
  if (real && real === realOrNull(fileURLToPath(import.meta.url))) return true;
  let fd;
  try {
    fd = openSync(file, "r");
    const head = Buffer.alloc(512);
    const read = readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, read).toString("utf8").includes(LAUNCHER_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The first executable `uno` on PATH that isn't this command: skips our bin
 * folders (compared by realpath) and any file that is our launcher.
 * @param {{ pathValue: string | undefined, skipDirs: string[] }} input
 * @returns {string | null}
 */
export function findOtherUno(input) {
  const skip = new Set(input.skipDirs.map(realOrNull).filter(Boolean));
  for (const dir of (input.pathValue ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const realDir = realOrNull(dir);
    if (!realDir || skip.has(realDir)) continue;
    const file = path.join(dir, "uno");
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, fsConstants.X_OK);
    } catch {
      continue;
    }
    if (isOurs(file, realOrNull(file))) continue;
    return file;
  }
  return null;
}

/**
 * Run the other `uno` with the same argv, stdio and env; resolves with its
 * exit code (a signal → 128 + its number).
 * @param {string} file
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
export function runOtherUno(file, argv, env) {
  return new Promise((resolve) => {
    const child = spawn(file, argv, { stdio: "inherit", env: { ...env, [DELEGATED_ENV]: "1" } });
    /** @type {NodeJS.Signals[]} */
    const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];
    const forward = (/** @type {NodeJS.Signals} */ signal) => child.kill(signal);
    for (const signal of forwarded) process.on(signal, forward);
    const done = (/** @type {number} */ code) => {
      for (const signal of forwarded) process.off(signal, forward);
      resolve(code);
    };
    child.on("error", (error) => {
      process.stderr.write(`uno: couldn't run ${file}: ${error.message}\n`);
      done(127);
    });
    child.on("exit", (code, signal) =>
      done(signal ? 128 + (osConstants.signals[signal] ?? 0) : (code ?? 1)),
    );
  });
}

// ── Run ─────────────────────────────────────────────────────────────────

/**
 * `uno <argv>`: prints, sets process.exitCode (0 ok, 1 failed, 2 usage).
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, home?: string }} [options]
 */
export async function run(argv, options = {}) {
  const env = options.env ?? process.env;
  const planned = planCommand(argv, {
    cwd: options.cwd ?? process.cwd(),
    home: options.home ?? homedir(),
  });
  if (planned.kind === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (planned.kind === "usage-error") {
    process.stderr.write(`uno: ${planned.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (planned.kind === "delegate") {
    const home = options.home ?? homedir();
    const other = env[DELEGATED_ENV]
      ? null
      : findOtherUno({
          pathValue: env.PATH,
          skipDirs: [
            path.join(home, ".uno", "sdk", "bin"),
            ...(process.argv[1] ? [path.dirname(process.argv[1])] : []),
          ],
        });
    if (!other) {
      process.stderr.write(
        `uno: Unknown command "${planned.argv[0]}". Run: uno help\n${UNO_API_CLI_HINT}\n`,
      );
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runOtherUno(other, planned.argv, env);
    return;
  }
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let hint;
  try {
    const bridge = bridgeFromEnv(env);
    if (planned.kind === "guide") {
      process.stdout.write(await fetchGuide(bridge, planned.topic));
      return;
    }
    if (planned.kind === "drive-ls") {
      const drive = /** @type {any} */ (await callTool(bridge, "drive_find", { limit: 1 }));
      const listing = await callTool(bridge, "cloud_list", {
        bucketId: drive.bucketId,
        ...(planned.folder ? { prefix: planned.folder } : {}),
      });
      process.stdout.write(
        `${planned.json ? JSON.stringify(listing, null, 2) : renderListing(listing)}\n`,
      );
      return;
    }
    if (planned.mayAsk) {
      hint = setTimeout(() => {
        process.stderr.write(
          "Waiting for Uno Work (it may be asking the person to Allow this)...\n",
        );
      }, WAITING_HINT_MS);
    }
    const result = await callTool(bridge, planned.tool, planned.args, {
      timeoutMs: planned.timeoutMs,
    });
    const out = planned.json
      ? typeof result === "string"
        ? result
        : JSON.stringify(result, null, 2)
      : renderResult(planned.render, result, planned.args);
    process.stdout.write(`${out}\n`);
  } catch (error) {
    if (!(error instanceof UnoCliError)) throw error;
    process.stderr.write(`uno: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (hint) clearTimeout(hint);
  }
}

function invokedDirectly() {
  try {
    return (
      !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) await run(process.argv.slice(2));
