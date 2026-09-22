import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createFolder,
  deleteEntries,
  listFolder,
  moveEntries,
  renameEntry,
  searchByName,
} from "./fileManager.ts";
import {
  FilesPathError,
  numberedName,
  resolveFilesRoot,
  resolveInsideRoot,
  validateEntryName,
} from "./filesPaths.ts";

let sandbox: string;
let root: string;
let outside: string;

beforeEach(async () => {
  sandbox = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "uno-files-")));
  root = nodePath.join(sandbox, "home");
  outside = nodePath.join(sandbox, "elsewhere");
  fs.mkdirSync(nodePath.join(root, "Documents"), { recursive: true });
  fs.mkdirSync(nodePath.join(root, ".ssh"));
  fs.mkdirSync(outside);
  fs.writeFileSync(nodePath.join(root, "Documents", "report.docx"), "docx");
  fs.writeFileSync(nodePath.join(root, "notes.md"), "# notes");
  fs.writeFileSync(nodePath.join(root, ".ssh", "id_rsa"), "key");
  fs.writeFileSync(nodePath.join(outside, "secret.txt"), "secret");
  fs.symlinkSync(outside, nodePath.join(root, "escape"));
  root = await resolveFilesRoot(root);
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

async function expectRefusal(promise: Promise<unknown>, code: FilesPathError["code"]) {
  await expect(promise).rejects.toBeInstanceOf(FilesPathError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("resolveInsideRoot", () => {
  it("accepts paths inside the root", async () => {
    expect(await resolveInsideRoot(root, nodePath.join(root, "notes.md"))).toBe(
      nodePath.join(root, "notes.md"),
    );
  });

  it("refuses relative paths, traversal and symlinks out of the root", async () => {
    await expectRefusal(resolveInsideRoot(root, "notes.md"), "invalid_path");
    await expectRefusal(resolveInsideRoot(root, `${root}/../elsewhere/secret.txt`), "outside_root");
    await expectRefusal(resolveInsideRoot(root, "/etc/passwd"), "outside_root");
    await expectRefusal(resolveInsideRoot(root, `${root}-evil/x`), "outside_root");
    await expectRefusal(resolveInsideRoot(root, `${root}/escape/secret.txt`), "outside_root");
    await expectRefusal(resolveInsideRoot(root, `${root}/notes.md\0`), "invalid_path");
    await expectRefusal(resolveInsideRoot(root, `${root}/missing.txt`), "not_found");
  });

  it("resolves not-yet-existing paths through their parent", async () => {
    expect(await resolveInsideRoot(root, `${root}/new.txt`, { mustExist: false })).toBe(
      nodePath.join(root, "new.txt"),
    );
    await expectRefusal(
      resolveInsideRoot(root, `${root}/escape/new.txt`, { mustExist: false }),
      "outside_root",
    );
  });
});

describe("names", () => {
  it("validates what a person types", () => {
    expect(validateEntryName("Q3 report.docx")).toBe("Q3 report.docx");
    for (const bad of ["", "   ", ".", "..", "a/b", "a\\b", "a\0b", "x".repeat(256)]) {
      expect(() => validateEntryName(bad), JSON.stringify(bad)).toThrow(FilesPathError);
    }
  });

  it("numbers duplicates before the extension", () => {
    expect(numberedName("report.docx", 2)).toBe("report (2).docx");
    expect(numberedName("Makefile", 3)).toBe("Makefile (3)");
    expect(numberedName(".env", 2)).toBe(".env (2)");
  });
});

describe("listFolder", () => {
  it("lists folders first, hides dotfiles unless asked", async () => {
    const result = await listFolder(root, {});
    expect(result.path).toBe(root);
    expect(result.parentPath).toBeNull();
    expect(result.entries.map((entry) => entry.name)).toEqual(["Documents", "escape", "notes.md"]);
    const withHidden = await listFolder(root, { showHidden: true });
    expect(withHidden.entries.find((entry) => entry.name === ".ssh")?.hidden).toBe(true);
  });

  it("refuses to list outside the root", async () => {
    await expectRefusal(listFolder(root, { path: outside }), "outside_root");
    await expectRefusal(listFolder(root, { path: `${root}/escape` }), "outside_root");
  });
});

describe("mutations", () => {
  it("creates folders and refuses duplicates", async () => {
    const entry = await createFolder(root, { parentPath: root, name: "Photos" });
    expect(entry.kind).toBe("directory");
    await expectRefusal(createFolder(root, { parentPath: root, name: "Photos" }), "exists");
  });

  it("renames with each conflict policy", async () => {
    fs.writeFileSync(nodePath.join(root, "a.txt"), "A");
    fs.writeFileSync(nodePath.join(root, "b.txt"), "B");
    await expectRefusal(renameEntry(root, { path: `${root}/a.txt`, newName: "b.txt" }), "exists");
    const kept = await renameEntry(root, {
      path: `${root}/a.txt`,
      newName: "b.txt",
      onConflict: "keepBoth",
    });
    expect(kept.entry.name).toBe("b (2).txt");
    const replaced = await renameEntry(root, {
      path: kept.entry.path,
      newName: "b.txt",
      onConflict: "replace",
    });
    expect(replaced.entry.name).toBe("b.txt");
    expect(fs.readFileSync(nodePath.join(root, "b.txt"), "utf8")).toBe("A");
  });

  it("refuses renaming the root or into another folder", async () => {
    await expectRefusal(renameEntry(root, { path: root, newName: "x" }), "forbidden");
    await expectRefusal(
      renameEntry(root, { path: `${root}/notes.md`, newName: "../notes.md" }),
      "invalid_name",
    );
  });

  it("moves, keeps both on conflict and refuses moving a folder into itself", async () => {
    fs.writeFileSync(nodePath.join(root, "Documents", "notes.md"), "other");
    const moved = await moveEntries(root, {
      paths: [`${root}/notes.md`],
      destinationPath: `${root}/Documents`,
    });
    expect(moved[0]?.entry.name).toBe("notes (2).md");
    fs.mkdirSync(nodePath.join(root, "Documents", "Inner"));
    await expectRefusal(
      moveEntries(root, {
        paths: [`${root}/Documents`],
        destinationPath: `${root}/Documents/Inner`,
      }),
      "forbidden",
    );
    await expectRefusal(
      moveEntries(root, { paths: [`${root}/Documents/report.docx`], destinationPath: outside }),
      "outside_root",
    );
  });

  it("deletes files and folders but never the root or outside it", async () => {
    await deleteEntries(root, [`${root}/Documents`]);
    expect(fs.existsSync(nodePath.join(root, "Documents"))).toBe(false);
    await expectRefusal(deleteEntries(root, [root]), "forbidden");
    await expectRefusal(deleteEntries(root, [`${outside}/secret.txt`]), "outside_root");
    await expectRefusal(deleteEntries(root, [`${root}/escape/secret.txt`]), "outside_root");
    expect(fs.existsSync(nodePath.join(outside, "secret.txt"))).toBe(true);
  });
});

describe("searchByName", () => {
  it("finds by name case-insensitively, skipping hidden and symlinked folders", async () => {
    fs.writeFileSync(nodePath.join(root, ".ssh", "report-key"), "x");
    const result = await searchByName(root, { query: "REPORT" });
    expect(result.entries.map((entry) => entry.name)).toEqual(["report.docx"]);
    expect(result.truncated).toBe(false);
  });
});

describe("symlinked prefixes", () => {
  it("accepts a path that reaches the root through a symlink, and still refuses the outside", async () => {
    const alias = nodePath.join(sandbox, "alias");
    fs.symlinkSync(root, alias);
    expect(await resolveInsideRoot(root, `${alias}/notes.md`)).toBe(
      nodePath.join(root, "notes.md"),
    );
    expect(await resolveInsideRoot(root, `${alias}/new.md`, { mustExist: false })).toBe(
      nodePath.join(root, "new.md"),
    );
    await expectRefusal(resolveInsideRoot(root, `${alias}/escape/secret.txt`), "outside_root");
    await expectRefusal(
      resolveInsideRoot(root, `${alias}/../elsewhere/secret.txt`),
      "outside_root",
    );
  });
});
