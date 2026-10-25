import path from "node:path";

import { describe, expect, it } from "vitest";

import { boundaryDenial, isWithinRoot, resolveUserPath, UnoWorkToolError } from "./tools.ts";

const home = "/home/person";
const roots = [`${home}/projects/site`, `${home}/UnoWork/Assistants/assistant-ada`];
const boundary = { roots, name: "Ada" };

describe("a sandboxed assistant's boundary holds for the daemon-side tools", () => {
  it("inside its projects: allowed, including the folder itself", () => {
    expect(boundaryDenial(`${home}/projects/site`, boundary, home)).toBeNull();
    expect(boundaryDenial(`${home}/projects/site/dist/index.html`, boundary, home)).toBeNull();
    expect(
      boundaryDenial(`${home}/UnoWork/Assistants/assistant-ada/NOTES.md`, boundary, home),
    ).toBeNull();
  });

  it("outside: a line that names the assistant and the folder", () => {
    const denial = boundaryDenial(`${home}/projects/orders-bot/.env`, boundary, home);
    expect(denial).toContain("Ada works only in its projects");
    expect(denial).toContain("~/projects/orders-bot/.env");
    expect(boundaryDenial(`${home}/.ssh/id_ed25519`, boundary, home)).not.toBeNull();
    expect(boundaryDenial("/etc/passwd", boundary, home)).not.toBeNull();
  });

  it("a sibling with the same prefix is not inside", () => {
    expect(isWithinRoot(`${home}/projects/site-old/a`, `${home}/projects/site`)).toBe(false);
    expect(boundaryDenial(`${home}/projects/site-old/a`, boundary, home)).not.toBeNull();
  });

  it("`..` doesn't climb out", () => {
    const deps = {
      home,
      caller: {
        threadId: "t",
        threadTitle: "Chat",
        runtimeMode: "auto-accept-edits" as const,
        cwd: `${home}/projects/site`,
        boundary,
      },
    };
    expect(resolveUserPath("src/../dist", deps)).toBe(path.join(home, "projects/site/dist"));
    expect(() => resolveUserPath("../orders-bot/.env", deps)).toThrow(UnoWorkToolError);
    expect(() => resolveUserPath("~/.ssh/config", deps)).toThrow(/works only in its projects/);
  });

  it("no boundary (the person's chat, or an assistant that sees everything): as before", () => {
    const deps = {
      home,
      caller: {
        threadId: "t",
        threadTitle: "Chat",
        runtimeMode: "full-access" as const,
        cwd: undefined,
      },
    };
    expect(resolveUserPath("~/.ssh/config", deps)).toBe(`${home}/.ssh/config`);
    expect(boundaryDenial("/anywhere", null, home)).toBeNull();
    expect(boundaryDenial("/anywhere", undefined, home)).toBeNull();
  });
});

describe("mail attachments land where the caller can read them", () => {
  it("the person's chat: the home folder; a sandboxed assistant: its chat folder, else its first root", async () => {
    const { attachmentBase } = await import("./mailTools.ts");
    const open = {
      threadId: "t",
      threadTitle: "Chat",
      runtimeMode: "full-access" as const,
      cwd: `${home}/x`,
    };
    expect(attachmentBase({ home, caller: open })).toBe(home);
    const inside = { ...open, cwd: `${home}/projects/site`, boundary };
    expect(attachmentBase({ home, caller: inside })).toBe(`${home}/projects/site`);
    const outside = { ...open, cwd: `${home}/elsewhere`, boundary };
    expect(attachmentBase({ home, caller: outside })).toBe(roots[0]);
  });
});
