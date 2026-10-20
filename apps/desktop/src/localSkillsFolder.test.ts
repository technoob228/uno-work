import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { defaultSkillsFolder, readLocalSkillsFolder } from "./localSkillsFolder.ts";

describe("local skills folder", () => {
  it("opens at the first agent skills folder there is", () => {
    const home = mkdtempSync(Path.join(tmpdir(), "uno-local-skills-home-"));
    expect(defaultSkillsFolder(home)).toBe(home);
    mkdirSync(Path.join(home, ".agents", "skills"), { recursive: true });
    expect(defaultSkillsFolder(home)).toBe(Path.join(home, ".agents", "skills"));
    mkdirSync(Path.join(home, ".claude", "skills"), { recursive: true });
    expect(defaultSkillsFolder(home)).toBe(Path.join(home, ".claude", "skills"));
  });

  it("reads skills, follows linked skill folders, skips hidden and links inside", async () => {
    const base = mkdtempSync(Path.join(tmpdir(), "uno-local-skills-"));
    const root = Path.join(base, "skills");
    mkdirSync(Path.join(root, "pdf", "scripts"), { recursive: true });
    writeFileSync(Path.join(root, "pdf", "SKILL.md"), "---\nname: pdf\n---\n");
    writeFileSync(Path.join(root, "pdf", "scripts", "a.py"), "print(1)");
    mkdirSync(Path.join(root, ".system", "x"), { recursive: true });
    writeFileSync(Path.join(root, ".system", "x", "SKILL.md"), "hidden");
    mkdirSync(Path.join(base, "repo", "mine"), { recursive: true });
    writeFileSync(Path.join(base, "repo", "mine", "SKILL.md"), "mine");
    symlinkSync(Path.join(base, "repo", "mine"), Path.join(root, "mine"));
    writeFileSync(Path.join(base, "secret"), "token");
    symlinkSync(Path.join(base, "secret"), Path.join(root, "pdf", "leak"));
    const result = await readLocalSkillsFolder(root);
    expect(result.files.map((f) => f.path).toSorted()).toEqual([
      "mine/SKILL.md",
      "pdf/SKILL.md",
      "pdf/scripts/a.py",
    ]);
  });
});
