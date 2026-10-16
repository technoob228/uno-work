/**
 * `uno` CLI: argv → which `uno-work` tool with which arguments (pure), the
 * bridge call's error handling against a fake daemon, and the printed text.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CALL_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
  UNO_API_CLI_HINT,
  UnoCliError,
  bridgeFromEnv,
  callTool,
  findOtherUno,
  planCommand,
  renderListing,
  renderResult,
  renderStatus,
} from "./uno-cli.mjs";

const where = { cwd: "/home/me/projects/site", home: "/home/me" };
const plan = (line: string) => planCommand(line.split(" ").filter(Boolean), where);

describe("planCommand", () => {
  it("maps status and cleanup", () => {
    expect(plan("status")).toEqual({
      kind: "call",
      tool: "computer_status",
      args: {},
      json: false,
      render: "status",
      timeoutMs: CALL_TIMEOUT_MS,
      mayAsk: false,
    });
    expect(plan("status --json")).toMatchObject({ tool: "computer_status", json: true });
    expect(plan("cleanup")).toMatchObject({ tool: "computer_cleanup", args: {}, mayAsk: false });
    expect(plan("cleanup --apply")).toMatchObject({
      tool: "computer_cleanup",
      args: { apply: true },
      mayAsk: true,
    });
  });

  it("maps drive put with absolute paths and a Drive folder", () => {
    expect(plan("drive put report.pdf ~/Documents/a.txt /tmp/b --to /Reports/2026")).toEqual({
      kind: "call",
      tool: "drive_save",
      args: {
        paths: ["/home/me/projects/site/report.pdf", "/home/me/Documents/a.txt", "/tmp/b"],
        folder: "Reports/2026",
      },
      json: false,
      render: "put",
      timeoutMs: TRANSFER_TIMEOUT_MS,
      mayAsk: true,
    });
    expect(plan("drive put x.txt")).toMatchObject({
      args: { paths: ["/home/me/projects/site/x.txt"] },
    });
    expect(plan("drive put --to=Tmp/ x.txt")).toMatchObject({
      args: { paths: ["/home/me/projects/site/x.txt"], folder: "Tmp/" },
    });
  });

  it("maps drive get, link, find and ls", () => {
    expect(plan("drive get Reports/q3.pdf /Photos/ --to out")).toMatchObject({
      tool: "drive_get",
      args: { keys: ["Reports/q3.pdf", "Photos/"], folder: "/home/me/projects/site/out" },
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    expect(plan("drive get a.txt")).toMatchObject({ args: { keys: ["a.txt"] } });
    expect(plan("drive link Reports/q3.pdf --days 3")).toMatchObject({
      tool: "drive_share_link",
      args: { key: "Reports/q3.pdf", expiresInHours: 72 },
      mayAsk: true,
    });
    expect(plan("drive link a.txt")).toMatchObject({ args: { key: "a.txt" } });
    expect(plan("drive find tax 2025 --smart -n 5")).toMatchObject({
      tool: "drive_find",
      args: { query: "tax 2025", smart: true, limit: 5 },
    });
    expect(plan("drive find")).toMatchObject({ tool: "drive_find", args: {} });
    expect(plan("drive ls")).toEqual({ kind: "drive-ls", folder: "", json: false });
    expect(plan("drive ls /Reports")).toEqual({
      kind: "drive-ls",
      folder: "Reports/",
      json: false,
    });
  });

  it("maps guide and help", () => {
    expect(plan("guide storage")).toEqual({ kind: "guide", topic: "storage" });
    expect(plan("guide")).toEqual({ kind: "guide", topic: "overview" });
    expect(plan("")).toEqual({ kind: "help" });
    expect(plan("help")).toEqual({ kind: "help" });
    expect(plan("drive put --help")).toEqual({ kind: "help" });
  });

  it("refuses bad input with a usage error", () => {
    for (const line of [
      "drive",
      "drive rm x",
      "drive put",
      "drive get",
      "drive link",
      "drive link a b",
      "drive link a --days 91",
      "drive link a --days 0",
      "drive put x --to",
      "status now",
      "cleanup --force",
      "status --json=1",
    ]) {
      expect(plan(line), line).toMatchObject({ kind: "usage-error" });
    }
  });
});

describe("the Uno API CLI's commands", () => {
  const cli = fileURLToPath(new URL("./uno-cli.mjs", import.meta.url));
  const launcher =
    '#!/usr/bin/env node\nimport("../js/uno-cli.mjs").then((cli) => cli.run(process.argv.slice(2)));\n';
  let root = "";
  const dir = (name: string) => {
    const full = path.join(root, name);
    fs.mkdirSync(full, { recursive: true });
    return full;
  };
  const script = (folder: string, body: string, mode = 0o755) =>
    fs.writeFileSync(path.join(folder, "uno"), body, { mode });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "uno-cli-path-"));
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("hands other first words to it", () => {
    expect(plan("boxes list --json")).toEqual({
      kind: "delegate",
      argv: ["boxes", "list", "--json"],
    });
    expect(plan("--version")).toEqual({ kind: "delegate", argv: ["--version"] });
    // Their help flags are theirs; ours only inside our commands or bare.
    expect(plan("boxes create --help")).toEqual({
      kind: "delegate",
      argv: ["boxes", "create", "--help"],
    });
    expect(plan("git commit -h")).toEqual({ kind: "delegate", argv: ["git", "commit", "-h"] });
    for (const line of [
      "",
      "help",
      "--help",
      "-h",
      "status -h",
      "cleanup --help",
      "guide --help",
    ]) {
      expect(plan(line), line).toEqual({ kind: "help" });
    }
  });

  it.skipIf(process.platform === "win32")("finds the next uno on PATH, never itself", () => {
    const ours = dir("home/.uno/sdk/bin");
    script(ours, launcher);
    const oursLink = path.join(root, "ours-link");
    fs.symlinkSync(ours, oursLink);
    const copy = dir("copy"); // a copy of our launcher elsewhere on PATH
    script(copy, launcher);
    const plain = dir("plain"); // not executable
    script(plain, "#!/bin/sh\n", 0o644);
    const self = dir("self"); // this very file linked as `uno`
    fs.symlinkSync(cli, path.join(self, "uno"));
    const other = dir("other");
    script(other, '#!/bin/sh\necho "api-cli:$*"\n');

    const found = findOtherUno({
      pathValue: [oursLink, copy, plain, self, path.join(root, "missing"), other].join(
        path.delimiter,
      ),
      skipDirs: [ours],
    });
    expect(found).toBe(path.join(other, "uno"));
    expect(
      findOtherUno({ pathValue: [oursLink, copy, self].join(path.delimiter), skipDirs: [ours] }),
    ).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "runs it with the same argv and exit code, or explains where to get it",
    () => {
      const other = dir("api-cli");
      script(other, '#!/bin/sh\necho "api-cli:$*"\n[ "$1" = die ] && kill -TERM $$\nexit 3\n');
      const home = dir("home2");
      const ours = dir("home2/.uno/sdk/bin");
      script(ours, launcher);
      const runCli = (args: string[], pathDirs: string[]) =>
        spawnSync(process.execPath, [cli, ...args], {
          encoding: "utf8",
          env: {
            HOME: home,
            PATH: [...pathDirs, path.dirname(process.execPath)].join(path.delimiter),
          },
        });

      const delegated = runCli(["boxes", "list", "--json"], [ours, other]);
      expect(delegated.stdout).toBe("api-cli:boxes list --json\n");
      expect(delegated.status).toBe(3);
      expect(runCli(["die"], [ours, other]).status).toBe(128 + os.constants.signals.SIGTERM);

      const missing = runCli(["boxes", "list"], [ours]);
      expect(missing.status).toBe(2);
      expect(missing.stderr).toContain('Unknown command "boxes"');
      expect(missing.stderr).toContain(UNO_API_CLI_HINT);

      const help = runCli(["help"], [ours, other]);
      expect(help.stdout.trimEnd().split("\n").at(-1)).toBe(
        "Other commands go to the Uno API CLI when it is installed.",
      );
    },
  );
});

describe("bridgeFromEnv", () => {
  it("explains where to run it without the bridge", () => {
    expect(() => bridgeFromEnv({})).toThrow(
      "Run this inside an Uno Work chat or app terminal (UNO_WORK_BRIDGE_URL is not set).",
    );
    expect(() => bridgeFromEnv({ UNO_WORK_BRIDGE_URL: "http://127.0.0.1:1" })).toThrow(UnoCliError);
    expect(
      bridgeFromEnv({ UNO_WORK_BRIDGE_URL: "http://127.0.0.1:1/", UNO_WORK_BRIDGE_TOKEN: "t" }),
    ).toEqual({ url: "http://127.0.0.1:1", token: "t" });
  });
});

describe("callTool", () => {
  const seen: Array<{ auth: string | undefined; body: unknown }> = [];
  let url = "";
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as { params: { name: string } };
      seen.push({ auth: req.headers.authorization, body });
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      switch (body.params.name) {
        case "ok":
          return reply(200, {
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: '{"a":1}' }], isError: false },
          });
        case "fails":
          return reply(200, {
            jsonrpc: "2.0",
            id: 1,
            result: { content: [{ type: "text", text: "Cloud storage is full." }], isError: true },
          });
        case "denied":
          return reply(401, { error: "unauthorized", message: "This chat's token expired." });
        default:
          return reply(200, {
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32602, message: `Unknown tool: ${body.params.name}` },
          });
      }
    });
  });
  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("sends one tools/call with the bearer token and returns parsed JSON", async () => {
    await expect(callTool({ url, token: "tok" }, "ok", { x: 1 })).resolves.toEqual({ a: 1 });
    expect(seen.at(-1)).toEqual({
      auth: "Bearer tok",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ok", arguments: { x: 1 } },
      },
    });
  });

  it("turns tool errors, HTTP refusals and unknown tools into plain messages", async () => {
    const bridge = { url, token: "tok" };
    await expect(callTool(bridge, "fails", {})).rejects.toThrow("Cloud storage is full.");
    await expect(callTool(bridge, "denied", {})).rejects.toThrow("This chat's token expired.");
    await expect(callTool(bridge, "computer_cleanup", {})).rejects.toThrow(
      "This Uno Work version has no computer_cleanup yet.",
    );
    await expect(callTool({ url: "http://127.0.0.1:9", token: "t" }, "ok", {})).rejects.toThrow(
      "Can't reach Uno Work",
    );
  });
});

describe("output", () => {
  it("prints status, listings and transfers for a person", () => {
    const status = renderStatus({
      hostname: "box",
      platform: "linux",
      unoCloudComputer: { id: 7, vcpu: 2, ramMb: 4096, diskGb: 20 },
      cpu: { count: 2, usedPct: 12, load1: 0.3 },
      memoryMb: { total: 4096, used: 1024, available: 3072 },
      disks: [{ mount: "/home/me", totalGb: 20, freeGb: 2 }],
      topUsers: [{ name: "Claude Code", memMb: 512 }],
      apps: { total: 3, running: 2 },
      notes: ["Disk is almost full."],
    });
    expect(status).toContain("Uno cloud computer 7 (2 vCPU, 4.0 GB RAM, 20 GB disk)");
    expect(status).toContain("Disk    /home/me: 2 GB free of 20 GB (90% used)");
    expect(status).toContain("! Disk is almost full.");

    expect(
      renderListing({
        prefix: "",
        folders: [{ prefix: "Reports/" }],
        objects: [{ key: "a.txt", size: 2048, modifiedAt: "2026-10-16T10:00:00Z" }],
      }),
    ).toBe("Reports/\na.txt  2.0 KB  2026-10-16");

    expect(
      renderResult(
        "put",
        { files: 1, bytes: 10, skipped: [] },
        { paths: ["/home/me/x.txt"], folder: "Tmp" },
      ),
    ).toBe("Saved 1 file(s), 10 B, to Uno Drive Tmp/\n  Tmp/x.txt");
  });
});
