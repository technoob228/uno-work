import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimChatFolder } from "./noProjectFolder.ts";

let home = "";
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "no-project-"));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const claim = (text: string) =>
  claimChatFolder({
    root: path.join(home, "chats"),
    threadId: "11111111-2222-3333-4444-a1b2c3d4e5f6",
    text,
    date: "2026-10-30",
  });

describe("claimChatFolder", () => {
  it("makes ~/chats and a folder of the chat's own in it", async () => {
    const folder = await claim("Convert these PNGs");
    expect(path.basename(folder)).toBe("2026-10-30-convert-these-pngs-c3d4e5f6");
    expect((await stat(folder)).isDirectory()).toBe(true);
  });

  it("never gives two chats the same folder", async () => {
    const first = await claim("Same words");
    const second = await claim("Same words");
    expect(second).toBe(`${first}-2`);
    expect(await readdir(path.join(home, "chats"))).toHaveLength(2);
  });

  it("stays inside ~/chats whatever the message says", async () => {
    const folder = await claim("../../../etc/passwd");
    expect(path.dirname(folder)).toBe(path.join(home, "chats"));
  });

  it("fails when ~/chats can't be a folder", async () => {
    await writeFile(path.join(home, "chats"), "a file");
    await expect(claim("hi")).rejects.toThrow();
  });
});
