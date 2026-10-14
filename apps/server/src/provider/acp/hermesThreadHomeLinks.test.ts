import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hermesThreadHomeLinks } from "./HermesAcpSupport.ts";
import { linkThreadHome } from "./hermesThreadHomeLinks.ts";

describe("linkThreadHome", () => {
  let root: string;
  let shared: string;
  let thread: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "hermes-links-"));
    shared = nodePath.join(root, "hermes-home-hermes");
    thread = nodePath.join(shared, "threads", "t1");
    await fs.mkdir(thread, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const links = (provider: "uno" | "chatgpt" | "claude") =>
    hermesThreadHomeLinks({
      provider,
      threadHome: thread,
      sharedHome: shared,
      join: nodePath.join,
    });

  it("links the ChatGPT sign-in so every chat writes the one shared auth.json", async () => {
    expect(await linkThreadHome(links("chatgpt"))).toEqual(["linked", "linked", "linked"]);
    // Hermes writes through the link (utils.atomic_replace keeps symlinks).
    await fs.writeFile(nodePath.join(thread, "auth.json"), '{"version":1}');
    expect(await fs.readFile(nodePath.join(shared, "auth.json"), "utf8")).toBe('{"version":1}');
    expect((await fs.lstat(nodePath.join(thread, "installs"))).isSymbolicLink()).toBe(true);
    expect((await fs.stat(nodePath.join(shared, "installs"))).isDirectory()).toBe(true);
  });

  it("is idempotent", async () => {
    await linkThreadHome(links("claude"));
    expect(await linkThreadHome(links("claude"))).toEqual(["kept", "kept"]);
  });

  it("moves a chat's own auth.json aside instead of losing it", async () => {
    await fs.writeFile(nodePath.join(thread, "auth.json"), "own");
    const outcomes = await linkThreadHome(links("chatgpt"), () => new Date("2026-10-14T12:00:00Z"));
    expect(outcomes[1]).toBe("moved-aside");
    expect(
      await fs.readFile(nodePath.join(thread, "auth.json.own-2026-10-14T12-00-00-000Z"), "utf8"),
    ).toBe("own");
  });

  it("leaves a chat's own Hermes runtime in place", async () => {
    await fs.mkdir(nodePath.join(thread, "installs", "abc"), { recursive: true });
    expect((await linkThreadHome(links("uno")))[0]).toBe("own-dir");
    expect((await fs.lstat(nodePath.join(thread, "installs"))).isDirectory()).toBe(true);
  });
});
