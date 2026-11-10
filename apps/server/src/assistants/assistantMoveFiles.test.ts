import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectFiles,
  historyFiles,
  moveMarkOf,
  readMoves,
  safeRelativePath,
  updateMoves,
  writeFiles,
} from "./assistantMoveFiles.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "assistant-move-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("collectFiles / writeFiles", () => {
  it("carries the folder over, without the computer's own files and caches", async () => {
    const source = await tempDir();
    await fsp.mkdir(nodePath.join(source, "skills"), { recursive: true });
    await fsp.mkdir(nodePath.join(source, "node_modules", "x"), { recursive: true });
    await fsp.mkdir(nodePath.join(source, ".uno"), { recursive: true });
    await fsp.writeFile(nodePath.join(source, "NOTES.md"), "# remember the dentist\n");
    await fsp.writeFile(nodePath.join(source, "skills", "mail.md"), "skill");
    await fsp.writeFile(nodePath.join(source, ".uno", "profile.json"), "{}", { mode: 0o600 });
    await fsp.writeFile(nodePath.join(source, ".mcp.json"), '{"token":"secret"}');
    await fsp.writeFile(nodePath.join(source, ".uno-assistant.json"), "{}");
    await fsp.writeFile(nodePath.join(source, "node_modules", "x", "i.js"), "x");
    await fsp.symlink("/etc/passwd", nodePath.join(source, "link"));

    const collected = await collectFiles(source);
    expect(collected.files.map((file) => file.path).toSorted()).toEqual([
      ".uno/profile.json",
      "NOTES.md",
      "skills/mail.md",
    ]);
    expect(collected.skipped).toEqual([{ path: "link", reason: "a link" }]);

    const target = await tempDir();
    expect(await writeFiles(target, collected.files)).toBe(3);
    expect(await fsp.readFile(nodePath.join(target, "NOTES.md"), "utf8")).toBe(
      "# remember the dentist\n",
    );
    const mode = (await fsp.stat(nodePath.join(target, ".uno", "profile.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("a big file stays behind, named", async () => {
    const source = await tempDir();
    await fsp.writeFile(nodePath.join(source, "a.txt"), "1234567890");
    await fsp.writeFile(nodePath.join(source, "b.txt"), "1234567890");
    const collected = await collectFiles(source, { budgetBytes: 15 });
    expect(collected.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(collected.skipped[0]?.path).toBe("b.txt");
  });

  it("refuses paths that leave the assistant's folder", async () => {
    expect(safeRelativePath("../etc/passwd")).toBeNull();
    expect(safeRelativePath("/etc/passwd")).toBeNull();
    expect(safeRelativePath("a/../../b")).toBeNull();
    expect(safeRelativePath("a\\b")).toBeNull();
    expect(safeRelativePath("notes/today.md")).toBe("notes/today.md");
    const target = await tempDir();
    await expect(
      writeFiles(target, [{ path: "../escape.txt", mode: 0o644, data: "eA==" }]),
    ).rejects.toThrow(/outside/);
  });
});

describe("historyFiles", () => {
  it("writes its chats as text, newest first, with a README", () => {
    const result = historyFiles({
      assistantName: "Uno",
      computerName: "kinship",
      movedAt: "2026-11-10T21:00:00.000Z",
      chats: [
        {
          title: "Plan / today",
          createdAt: "2026-11-09T08:00:00.000Z",
          messages: [
            { role: "user", text: "what's on today?", createdAt: "2026-11-09T08:00:00.000Z" },
            { role: "assistant", text: "Dentist at 3.", createdAt: "2026-11-09T08:00:05.000Z" },
          ],
        },
        { title: "empty", createdAt: "2026-11-08T08:00:00.000Z", messages: [] },
      ],
    });
    expect(result.chats).toBe(1);
    const paths = result.files.map((file) => file.path);
    expect(paths).toEqual([
      "history/kinship/2026-11-09 Plan today.md",
      "history/kinship/README.md",
    ]);
    const text = Buffer.from(result.files[0]!.data, "base64").toString("utf8");
    expect(text).toContain("**You**");
    expect(text).toContain("Dentist at 3.");
  });
});

describe("the record of moves", () => {
  it("marks where it went, and the newer move wins", async () => {
    const state = await tempDir();
    await updateMoves(state, (record) => ({
      ...record,
      outgoing: {
        "assistant-home": {
          projectId: "assistant-home",
          to: { name: "stage-work", boxId: 2531 },
          at: "2026-11-10T10:00:00.000Z",
          isUno: true,
          deleted: false,
          connectorRows: [],
          reminders: [],
        },
      },
    }));
    let record = await readMoves(state);
    expect(moveMarkOf(record, "assistant-home")?.movedTo?.name).toBe("stage-work");
    expect(moveMarkOf(record, "assistant-mia")).toBeNull();

    await updateMoves(state, (current) => ({
      ...current,
      incoming: {
        "assistant-home": {
          projectId: "assistant-home",
          from: { name: "stage-work", boxId: 2531 },
          at: "2026-11-10T12:00:00.000Z",
          stage: "active",
          isUno: true,
          created: false,
          backup: null,
          activated: [],
          reminderIds: [],
        },
      },
    }));
    record = await readMoves(state);
    expect(moveMarkOf(record, "assistant-home")).toEqual({
      movedTo: null,
      movedInAt: "2026-11-10T12:00:00.000Z",
      movedFrom: "stage-work",
    });
    const mode = (await fsp.stat(nodePath.join(state, "assistants", "moves.json"))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("a staged move-in is no claim yet", async () => {
    const state = await tempDir();
    await updateMoves(state, () => ({
      outgoing: {},
      incoming: {
        "assistant-home": {
          projectId: "assistant-home",
          from: { name: "kinship", boxId: 3273 },
          at: "2026-11-10T12:00:00.000Z",
          stage: "staged",
          isUno: true,
          created: false,
          backup: null,
          activated: [],
          reminderIds: [],
        },
      },
    }));
    expect(moveMarkOf(await readMoves(state), "assistant-home")).toBeNull();
  });
});
