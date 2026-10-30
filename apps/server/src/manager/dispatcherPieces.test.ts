import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { folderProjectTitle, isRegistrableFolder } from "../agentThreads/registerFolder.ts";
import {
  appendAssistantNotes,
  appendToOutcomesLog,
  editAssistantNotes,
  readAssistantNotes,
} from "./assistantNotes.ts";
import { fitReplyToScreen, SCREEN_MAX_CHARS } from "./connectorReplyText.ts";

describe("fitReplyToScreen", () => {
  it("a short answer stays as it is", () => {
    expect(
      fitReplyToScreen("Принял, запустил «Бэклог luckyip».", {
        language: "ru",
        moreUrl: "https://x.uno4.work",
      }),
    ).toEqual({
      text: "Принял, запустил «Бэклог luckyip».",
      cut: false,
    });
  });

  it("a wall of text becomes one screen with a link to the rest", () => {
    const wall = Array.from(
      { length: 60 },
      (_, i) => `- пункт ${i}: что-то длинное про задачу`,
    ).join("\n");
    const fitted = fitReplyToScreen(wall, { language: "ru", moreUrl: "https://x.uno4.work" });
    expect(fitted.cut).toBe(true);
    expect(fitted.text.length).toBeLessThanOrEqual(SCREEN_MAX_CHARS + 120);
    expect(fitted.text).toContain("https://x.uno4.work");
  });

  it("an open code fence is closed", () => {
    const text = `Итог:\n\`\`\`\n${"x = 1\n".repeat(300)}`;
    const fitted = fitReplyToScreen(text, { language: "en", moreUrl: "https://a" });
    expect((fitted.text.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe("folders a task may start in", () => {
  it("any non-hidden folder under home", () => {
    expect(isRegistrableFolder("/home/me/projects/luckyip", "/home/me")).toBe(true);
    expect(isRegistrableFolder("/home/me/.ssh", "/home/me")).toBe(false);
    expect(isRegistrableFolder("/home/me/projects/.git/x", "/home/me")).toBe(false);
    expect(isRegistrableFolder("/etc", "/home/me")).toBe(false);
    expect(folderProjectTitle("/home/me/projects/luckyip", "/home/me")).toBe("luckyip");
  });
});

describe("notes tools", () => {
  let root: string;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "uno-notes-"));
    await fs.writeFile(
      path.join(root, "NOTES.md"),
      "# Notes\n- 2026-10-01 likes short answers (you)\n",
    );
    await fs.writeFile(
      path.join(root, "ROUTING.md"),
      "# Routing\n\n| Task type | Harness | Model | Effort | Source | Why |\n|---|---|---|---|---|---|\n| UI | claudeAgent | claude-opus-5-5 | high | you | taste |\n\n## Outcomes log\n\n<!-- date | … -->\n\n## Proposals\n\n## Declined\n",
    );
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("appends and reads notes", async () => {
    expect(
      (await appendAssistantNotes(root, { text: "- 2026-10-29 luckyip lives in ~/projects" })).ok,
    ).toBe(true);
    const read = await readAssistantNotes(root, {});
    expect(read.ok && JSON.stringify(read.value)).toContain("luckyip lives");
  });

  it("an Outcomes log line lands in its section, not at the end", async () => {
    expect(
      (
        await appendAssistantNotes(root, {
          file: "ROUTING.md",
          text: "2026-10-29 | UI | opus | ok | tests",
        })
      ).ok,
    ).toBe(true);
    const content = await fs.readFile(path.join(root, "ROUTING.md"), "utf8");
    expect(content.indexOf("2026-10-29 | UI")).toBeLessThan(content.indexOf("## Proposals"));
    expect(appendToOutcomesLog("# no log\n", "x")).toBeNull();
  });

  it("the person's lines can't be changed, USER.md can't be written, no escaping the folder", async () => {
    const edit = await editAssistantNotes(root, {
      file: "ROUTING.md",
      find: "| UI | claudeAgent | claude-opus-5-5 | high | you | taste |",
      replace: "| UI | uno | uno/uno/smart | — | learned | cheaper |",
    });
    expect(edit.ok).toBe(false);
    expect((await appendAssistantNotes(root, { file: "USER.md", text: "x" })).ok).toBe(false);
    expect((await readAssistantNotes(root, { file: "../../etc/passwd" })).ok).toBe(false);
  });
});
