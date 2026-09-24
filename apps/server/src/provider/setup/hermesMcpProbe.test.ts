import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { probeHermesMcpHttp, pythonFromShebang, resolveOnPath } from "./hermesMcpProbe.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A uv-tool-shaped install: bin/hermes → tool/bin/hermes with a python shebang. */
async function fakeHermes(pythonExitCode: number) {
  const root = await mkdtemp(nodePath.join(os.tmpdir(), "hermes-probe-"));
  dirs.push(root);
  const toolBin = nodePath.join(root, "tool", "bin");
  const userBin = nodePath.join(root, "bin");
  await mkdir(toolBin, { recursive: true });
  await mkdir(userBin, { recursive: true });
  const python = nodePath.join(toolBin, "python");
  await writeFile(python, `#!/bin/sh\nexit ${pythonExitCode}\n`);
  await chmod(python, 0o755);
  const entry = nodePath.join(toolBin, "hermes");
  await writeFile(entry, `#!${python}\nprint("hermes")\n`);
  await chmod(entry, 0o755);
  await symlink(entry, nodePath.join(userBin, "hermes"));
  return { userBin };
}

describe("hermes MCP probe", () => {
  it("reads the interpreter of a uv tool entry point", () => {
    expect(pythonFromShebang("#!/home/u/.local/share/uv/tools/hermes-agent/bin/python")).toBe(
      "/home/u/.local/share/uv/tools/hermes-agent/bin/python",
    );
    expect(pythonFromShebang("#!/usr/bin/python3.12")).toBe("/usr/bin/python3.12");
    expect(pythonFromShebang("#!/bin/sh")).toBeNull();
    expect(pythonFromShebang("print('x')")).toBeNull();
  });

  it("finds a command on PATH", async () => {
    const { userBin } = await fakeHermes(0);
    expect(await resolveOnPath("hermes", `/nonexistent:${userBin}`)).toBe(
      nodePath.join(userBin, "hermes"),
    );
    expect(await resolveOnPath("hermes", "/nonexistent")).toBeNull();
  });

  it("is ok when Hermes' python has the HTTP MCP client, broken when not", async () => {
    const ok = await fakeHermes(0);
    expect(await probeHermesMcpHttp({ binaryPath: "hermes", env: { PATH: ok.userBin } })).toBe(
      "ok",
    );
    const broken = await fakeHermes(1);
    expect(await probeHermesMcpHttp({ binaryPath: "hermes", env: { PATH: broken.userBin } })).toBe(
      "broken",
    );
    expect(await probeHermesMcpHttp({ binaryPath: "hermes", env: { PATH: "/nonexistent" } })).toBe(
      "unknown",
    );
  });
});
