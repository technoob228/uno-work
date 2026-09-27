import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isSendableConnectorPath, resolveConnectorOutgoingFile } from "./connectorOutgoingFiles.ts";

describe("isSendableConnectorPath", () => {
  const root = "/work/project";
  it("allows ordinary files inside the workspace", () => {
    expect(isSendableConnectorPath("/work/project/out/report.pdf", [root])).toBe(true);
  });
  it("refuses files outside, hidden paths and keys", () => {
    for (const file of [
      "/etc/passwd",
      "/work/project-other/a.txt",
      "/work/project/.env",
      "/work/project/.ssh/config",
      "/work/project/.git/config",
      "/work/project/certs/server.pem",
      "/work/project/id_ed25519",
      "/work/project",
    ]) {
      expect(isSendableConnectorPath(file, [root])).toBe(false);
    }
  });
});

describe("resolveConnectorOutgoingFile", () => {
  let dir: string;
  let outside: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "uno-sendfile-"));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), "uno-sendfile-out-"));
    await fs.writeFile(path.join(dir, "report.txt"), "ok");
    await fs.writeFile(path.join(outside, "secret.txt"), "no");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt"));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("resolves absolute and relative paths inside the workspace", async () => {
    const real = await fs.realpath(path.join(dir, "report.txt"));
    expect(await resolveConnectorOutgoingFile(path.join(dir, "report.txt"), [dir])).toEqual({
      ok: true,
      path: real,
    });
    expect(await resolveConnectorOutgoingFile("report.txt", [dir])).toEqual({
      ok: true,
      path: real,
    });
  });

  it("refuses symlinks that escape, outside paths and missing roots", async () => {
    expect((await resolveConnectorOutgoingFile(path.join(dir, "link.txt"), [dir])).ok).toBe(false);
    expect((await resolveConnectorOutgoingFile(path.join(outside, "secret.txt"), [dir])).ok).toBe(
      false,
    );
    expect((await resolveConnectorOutgoingFile(path.join(dir, "report.txt"), [])).ok).toBe(false);
  });
});
