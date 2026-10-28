/**
 * The assistant sandbox for real: bwrap on Linux, a made-up home with an
 * allowed project, a forbidden one and the person's secrets. Skipped unless
 * `UNO_SANDBOX_IT=1` on a Linux machine with bubblewrap; how to run it in a
 * container is in the commit that added it (and below).
 *
 *   docker run --rm --privileged -v "$PWD":/repo -w /repo ubuntu:24.04 bash -c '
 *     apt-get update -qq && apt-get install -y -qq bubblewrap curl unzip ca-certificates >/dev/null &&
 *     useradd -m it && cp -r /repo /home/it/repo && chown -R it /home/it/repo &&
 *     su it -c "curl -fsSL https://bun.sh/install | bash >/dev/null &&
 *       cd ~/repo && ~/.bun/bin/bun install >/dev/null &&
 *       cd apps/server && UNO_SANDBOX_IT=1 ~/.bun/bin/bunx vitest run src/sandbox/harnessSandbox.integration.test.ts"'
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prepareSandboxHost, sandboxedCommand, type HarnessSandboxSpec } from "./harnessSandbox.ts";
import { findBwrapOnHost } from "./sandboxCapability.ts";

/** A shell line printing `name=ok` when `command` succeeds, `name=denied` otherwise. */
const check = (name: string, command: string) =>
  `if ${command} >/dev/null 2>&1; then echo ${name}=ok; else echo ${name}=denied; fi`;

const bwrap = process.platform === "linux" ? findBwrapOnHost() : null;
const enabled = process.env.UNO_SANDBOX_IT === "1" && bwrap !== null;

describe.skipIf(!enabled)("assistant sandbox (bwrap, Linux)", () => {
  // Not under /tmp: inside the sandbox /tmp is the assistant's own folder.
  // Made in beforeAll: a skipped suite still runs its body to collect tests.
  let root = "";
  const at = (...parts: string[]) => nodePath.join(root, ...parts);
  const home = () => at("home");
  const allowed = () => at("home", "projects", "allowed");
  const forbidden = () => at("home", "projects", "forbidden");
  const assistant = () => at("home", "UnoWork", "Assistants", "ana");
  const otherAssistant = () => at("home", "UnoWork", "Assistants", "bob");
  const daemonState = () => at("state");
  const write = (path: string, text: string) => {
    fs.mkdirSync(nodePath.dirname(path), { recursive: true });
    fs.writeFileSync(path, text);
  };

  beforeAll(() => {
    root = fs.realpathSync(
      fs.mkdtempSync(
        nodePath.join(process.env.UNO_SANDBOX_IT_ROOT ?? process.cwd(), ".sandbox-it-"),
      ),
    );
    write(nodePath.join(allowed(), "readme.txt"), "allowed-content");
    write(nodePath.join(forbidden(), "secret.txt"), "forbidden-content");
    write(nodePath.join(assistant(), ".mcp.json"), '{"mcpServers":{}}');
    write(nodePath.join(otherAssistant(), "NOTES.md"), "bob-notes");
    write(nodePath.join(home(), ".ssh", "id_ed25519"), "ssh-key");
    write(nodePath.join(home(), ".uno", "app-keys", "key"), "uno-token");
    write(nodePath.join(home(), ".uno", "sdk", "bin", "uno"), "#!/bin/sh\necho sdk");
    write(nodePath.join(home(), ".env"), "TOKEN=home-env");
    write(nodePath.join(daemonState(), "userdata", "settings.json"), '{"uno":{"apiKey":"k"}}');
  });

  const spec = (): HarnessSandboxSpec => ({
    plan: {
      bwrapPath: bwrap ?? "bwrap",
      home: home(),
      cwd: allowed(),
      writableDirs: [assistant(), allowed()],
      hiddenDirs: [],
      tmpDir: nodePath.join(daemonState(), "sandbox", "tmp", "assistant-ana"),
      assistantProjectId: "assistant-ana",
    },
    extras: { mounts: [] },
  });

  /** Runs `sh -c script` inside the sandbox; stdout lines are `name=ok|denied`. */
  const runInside = (script: string): Record<string, string> => {
    prepareSandboxHost(spec());
    const wrapped = sandboxedCommand(spec(), "/bin/sh", ["-c", script], process.env.PATH);
    const result = spawnSync(wrapped.command, [...wrapped.args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home() },
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("=") as [string, string]),
    );
  };

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads and writes the allowed project and its own folder", () => {
    const seen = runInside(
      [
        check("readAllowed", `grep -q allowed-content ${allowed()}/readme.txt`),
        check("writeAllowed", `sh -c 'echo made > ${allowed()}/made.txt'`),
        check("readOwnMcp", `cat ${assistant()}/.mcp.json`),
        check("writeOwn", `sh -c 'echo note > ${assistant()}/NOTES.md'`),
        check("tmp", "sh -c 'echo x > /tmp/x && cat /tmp/x'"),
        check("sdk", `test -f ${home()}/.uno/sdk/bin/uno`),
        check("cwd", `test "$(pwd)" = ${allowed()}`),
      ].join("\n"),
    );
    expect(seen).toEqual({
      readAllowed: "ok",
      writeAllowed: "ok",
      readOwnMcp: "ok",
      writeOwn: "ok",
      tmp: "ok",
      sdk: "ok",
      cwd: "ok",
    });
    expect(fs.readFileSync(nodePath.join(allowed(), "made.txt"), "utf8").trim()).toBe("made");
  });

  it("can't see another project, other assistants, the person's secrets or the daemon's state", () => {
    const seen = runInside(
      [
        check("listForbidden", `ls ${forbidden()}`),
        check("readForbidden", `cat ${forbidden()}/secret.txt`),
        check("otherAssistant", `cat ${otherAssistant()}/NOTES.md`),
        check("ssh", `cat ${home()}/.ssh/id_ed25519`),
        check("unoKeys", `cat ${home()}/.uno/app-keys/key`),
        check("homeEnv", `cat ${home()}/.env`),
        check("daemonState", `cat ${daemonState()}/userdata/settings.json`),
        check(
          "otherProcesses",
          "test -n \"$(ls /proc | grep -x 1)\" && test $(ls /proc | grep -c '^[0-9]') -lt 10",
        ),
      ].join("\n"),
    );
    expect(seen).toEqual({
      listForbidden: "denied",
      readForbidden: "denied",
      otherAssistant: "denied",
      ssh: "denied",
      unoKeys: "denied",
      homeEnv: "denied",
      daemonState: "denied",
      // Its own pid namespace: a handful of its own processes, not the host's.
      otherProcesses: "ok",
    });
  });
});
