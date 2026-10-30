import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveFileMentions } from "./fileMentions.ts";

let sandbox: string;
let home: string;
let project: string;

const write = (path: string, content = "x") => {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  fs.writeFileSync(path, content);
};

const resolve = async (mentions: string[], cwd: string | undefined = project) => {
  const { results } = await resolveFileMentions(home, {
    ...(cwd ? { cwd } : {}),
    mentions,
  });
  return Object.fromEntries(results.map((result) => [result.mention, result.path]));
};

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-mentions-")));
  home = nodePath.join(sandbox, "home");
  project = nodePath.join(home, "projects", "site");
  write(nodePath.join(home, "UnoWork", "report.md"));
  write(nodePath.join(home, "notes.txt"));
  write(nodePath.join(project, "README.md"));
  write(nodePath.join(project, "web", "index.html"));
  write(nodePath.join(project, "web", "старт файл.md"));
  write(nodePath.join(project, "dist", "index.html"));
  write(nodePath.join(project, "dist", "bundle.js"));
  write(nodePath.join(project, "node_modules", "x", "only-here.js"));
  write(nodePath.join(project, "docs", "deep", "guide.md"));
  write(nodePath.join(home, "projects", "site-root.md"));
});

afterEach(() => fs.rmSync(sandbox, { recursive: true, force: true }));

describe("resolveFileMentions", () => {
  it("expands ~ to the computer's home folder, not the chat's", async () => {
    expect(await resolve(["~/UnoWork/report.md"])).toEqual({
      "~/UnoWork/report.md": nodePath.join(home, "UnoWork", "report.md"),
    });
  });

  it("takes absolute paths as they are", async () => {
    const path = nodePath.join(project, "README.md");
    expect(await resolve([path])).toEqual({ [path]: path });
  });

  it("starts relative mentions in the chat's folder", async () => {
    expect((await resolve(["web/index.html"]))["web/index.html"]).toBe(
      nodePath.join(project, "web", "index.html"),
    );
    expect((await resolve(["./README.md"]))["./README.md"]).toBe(
      nodePath.join(project, "README.md"),
    );
  });

  it("finds paths written from a folder above the chat's", async () => {
    const cwd = nodePath.join(project, "web");
    expect((await resolve(["site/README.md"], cwd))["site/README.md"]).toBe(
      nodePath.join(project, "README.md"),
    );
    expect((await resolve(["notes.txt"], cwd))["notes.txt"]).toBe(nodePath.join(home, "notes.txt"));
  });

  it("uses the home folder when the chat has no folder", async () => {
    expect((await resolve(["notes.txt"], ""))["notes.txt"]).toBe(nodePath.join(home, "notes.txt"));
  });

  it("finds a bare name under the chat's folder, the shallowest and never in dist", async () => {
    expect((await resolve(["index.html"]))["index.html"]).toBe(
      nodePath.join(project, "web", "index.html"),
    );
    expect((await resolve(["guide.md"]))["guide.md"]).toBe(
      nodePath.join(project, "docs", "deep", "guide.md"),
    );
    expect((await resolve(["deep/guide.md"]))["deep/guide.md"]).toBe(
      nodePath.join(project, "docs", "deep", "guide.md"),
    );
  });

  it("does not walk into node_modules or build output", async () => {
    expect(await resolve(["only-here.js", "bundle.js"])).toEqual({
      "only-here.js": null,
      "bundle.js": null,
    });
  });

  it("finds names with spaces and any script", async () => {
    expect((await resolve(["web/старт файл.md"]))["web/старт файл.md"]).toBe(
      nodePath.join(project, "web", "старт файл.md"),
    );
  });

  it("says nothing exists for what doesn't", async () => {
    expect(await resolve(["~/nope.md", "/chat", "and/or", "example.com", "Node.js"])).toEqual({
      "~/nope.md": null,
      "/chat": null,
      "and/or": null,
      "example.com": null,
      "Node.js": null,
    });
  });

  it("reports folders inside the home folder only", async () => {
    const { results } = await resolveFileMentions(home, {
      cwd: project,
      mentions: ["docs/", "web", sandbox],
    });
    expect(results).toEqual([
      { mention: "docs/", path: nodePath.join(project, "docs"), kind: "directory" },
      { mention: "web", path: nodePath.join(project, "web"), kind: "directory" },
      { mention: sandbox, path: null, kind: null },
    ]);
  });

  it("finds files outside the home folder (the panel can read them)", async () => {
    const outside = nodePath.join(sandbox, "outside.log");
    write(outside);
    expect(await resolve([outside])).toEqual({ [outside]: outside });
  });

  it("does not take a file for the folder a trailing slash asks for", async () => {
    expect(await resolve(["README.md/"])).toEqual({ "README.md/": null });
  });

  it("answers every mention once, in order", async () => {
    const { results } = await resolveFileMentions(home, {
      cwd: project,
      mentions: ["README.md", "nope.md", "README.md"],
    });
    expect(results.map((result) => result.mention)).toEqual(["README.md", "nope.md"]);
  });
});
