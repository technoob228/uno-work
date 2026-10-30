import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  isSendableConnectorPath,
  resolveConnectorOutgoingFile,
  sendableRoots,
} from "./connectorOutgoingFiles.ts";
import { queueOutgoingFile, QUEUED_FILE_TTL_MS, takeOutgoingFiles } from "./outgoingFileQueue.ts";

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

  it("finds a relative path in the chats the assistant started", async () => {
    const own = path.join(dir, "assistant");
    await fs.mkdir(own, { recursive: true });
    const real = await fs.realpath(path.join(dir, "report.txt"));
    expect(await resolveConnectorOutgoingFile("report.txt", [own, dir])).toEqual({
      ok: true,
      path: real,
    });
    expect((await resolveConnectorOutgoingFile("missing.txt", [own, dir])).ok).toBe(false);
    // A key is refused even when a later root has a sendable file of that name.
    await fs.writeFile(path.join(own, "id_rsa"), "key");
    expect((await resolveConnectorOutgoingFile("id_rsa", [own, dir])).ok).toBe(false);
  });

  it("refuses symlinks that escape, outside paths and missing roots", async () => {
    expect((await resolveConnectorOutgoingFile(path.join(dir, "link.txt"), [dir])).ok).toBe(false);
    expect((await resolveConnectorOutgoingFile(path.join(outside, "secret.txt"), [dir])).ok).toBe(
      false,
    );
    expect((await resolveConnectorOutgoingFile(path.join(dir, "report.txt"), [])).ok).toBe(false);
  });
});

describe("sendableRoots", () => {
  const home = "/home/me";
  const projects = ["/home/me/projects/luckyip", "/srv/site"];

  it("an assistant that reaches every project: the person's folders and all projects", () => {
    const roots = sendableRoots({
      threadRoot: "/home/me/.uno/assistants/uno",
      home,
      reach: "all",
      allProjectRoots: projects,
    });
    expect(roots).toEqual(
      expect.arrayContaining([
        "/home/me/.uno/assistants/uno",
        "/home/me/projects",
        "/home/me/Documents",
        "/home/me/Uploads",
        "/srv/site",
      ]),
    );
    expect(roots).not.toContain(home);
    // The luckyip case: a doc in a project folder is sendable…
    expect(isSendableConnectorPath("/home/me/projects/luckyip/docs/SUPPORT.md", roots)).toBe(true);
    // …keys and hidden files never, nor the home itself.
    for (const file of [
      "/home/me/.ssh/id_ed25519",
      "/home/me/projects/luckyip/.env",
      "/home/me/projects/luckyip/prod.env",
      "/home/me/Documents/server.pem",
      "/home/me/Documents/id_rsa",
      "/home/me/Downloads/credentials.json",
      "/home/me/notes.txt",
    ]) {
      expect(isSendableConnectorPath(file, roots)).toBe(false);
    }
  });

  it("adds the folders of the chats it started, for a chat outside the projects", () => {
    const roots = sendableRoots({
      threadRoot: "/home/me/.uno/assistants/ana",
      childRoots: ["/srv/worktree-of-a-chat"],
      home,
      reach: [],
      allProjectRoots: projects,
    });
    expect(isSendableConnectorPath("/srv/worktree-of-a-chat/docs/report.md", roots)).toBe(true);
    expect(isSendableConnectorPath("/srv/site/out/report.pdf", roots)).toBe(false);
  });

  it("only selected projects: those folders and the chat's own, nothing else", () => {
    const roots = sendableRoots({
      threadRoot: "/home/me/.uno/assistants/ana",
      home,
      reach: ["/srv/site"],
      allProjectRoots: projects,
    });
    expect(isSendableConnectorPath("/srv/site/out/report.pdf", roots)).toBe(true);
    expect(isSendableConnectorPath("/home/me/projects/luckyip/docs/SUPPORT.md", roots)).toBe(false);
    expect(isSendableConnectorPath("/home/me/Documents/cv.pdf", roots)).toBe(false);
  });
});

describe("outgoing file queue", () => {
  it("files queued in a turn go with its answer, once", () => {
    expect(queueOutgoingFile("t1", "/a.pdf", 1_000)).toBe(true);
    expect(queueOutgoingFile("t1", "/a.pdf", 1_001)).toBe(true);
    expect(queueOutgoingFile("t1", "/b.png", 1_002)).toBe(true);
    expect(takeOutgoingFiles("t1", 2_000)).toEqual(["/a.pdf", "/b.png"]);
    expect(takeOutgoingFiles("t1", 2_000)).toEqual([]);
  });

  it("stale files are dropped", () => {
    queueOutgoingFile("t2", "/old.pdf", 0);
    expect(takeOutgoingFiles("t2", QUEUED_FILE_TTL_MS + 1)).toEqual([]);
  });
});
