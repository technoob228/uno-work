import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeZip } from "../files/zipPackage.ts";
import {
  addStagedSkills,
  appendUploadChunk,
  clearStagesForTest,
  fetchCapped,
  type FetchLike,
  filesFromFolder,
  filesFromZip,
  findSkills,
  isPrivateAddress,
  resolveSkillLink,
  safeArchivePath,
  stageSkills,
} from "./skillImport.ts";
import { parseSkillManifest, skillFolderName } from "./skillManifest.ts";

const enc = (text: string) => new TextEncoder().encode(text);
const skillMd = (name: string, description = `Does ${name} things.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

function zipOf(files: Record<string, string>): Uint8Array {
  return writeZip(Object.entries(files).map(([name, text]) => ({ name, data: enc(text) })));
}

function base() {
  return mkdtempSync(nodePath.join(tmpdir(), "uno-skill-import-"));
}

afterEach(() => clearStagesForTest());

describe("SKILL.md frontmatter", () => {
  it("reads plain, quoted and block scalars", () => {
    expect(parseSkillManifest(skillMd("pdf"))).toEqual({
      name: "pdf",
      description: "Does pdf things.",
    });
    expect(parseSkillManifest(`---\nname: "x"\ndescription: 'It''s fine'\n---\n`)).toEqual({
      name: "x",
      description: "It's fine",
    });
    expect(
      parseSkillManifest(
        `---\nname: y\ndescription: >\n  One line\n  and more.\nlicense: MIT\n---\n`,
      ),
    ).toEqual({ name: "y", description: "One line and more." });
    expect(
      parseSkillManifest(`---\nname: z\ndescription: Starts here\n  and goes on\n---\n`),
    ).toEqual({
      name: "z",
      description: "Starts here and goes on",
    });
  });

  it("has no manifest without frontmatter", () => {
    expect(parseSkillManifest("# Just markdown")).toBeNull();
    expect(parseSkillManifest("---\nname: open\n")).toBeNull();
    expect(parseSkillManifest("---\nname: n\n---\n")).toEqual({ name: "n", description: null });
  });

  it("makes folder names agents accept", () => {
    expect(skillFolderName("PDF Tools")).toBe("pdf-tools");
    expect(skillFolderName("café--déjà_vu")).toBe("cafe-deja-vu");
    expect(skillFolderName("???")).toBeNull();
  });
});

describe("archive paths", () => {
  it("refuses zip slip and drops junk", () => {
    expect(() => safeArchivePath("../evil/SKILL.md")).toThrow(/outside/);
    expect(() => safeArchivePath("a/../../x")).toThrow(/outside/);
    expect(() => safeArchivePath("/etc/passwd")).toThrow(/absolute/);
    expect(() => safeArchivePath("C:\\Windows\\x")).toThrow(/absolute/);
    expect(safeArchivePath("__MACOSX/a/._SKILL.md")).toBeNull();
    expect(safeArchivePath("a/.git/config")).toBeNull();
    expect(safeArchivePath("a\\b\\SKILL.md")).toBe("a/b/SKILL.md");
  });

  it("refuses a whole zip with an escaping entry", () => {
    const bytes = zipOf({ "ok/SKILL.md": skillMd("ok"), "../../.bashrc": "rm -rf ~" });
    expect(() => filesFromZip(bytes)).toThrow(/outside/);
  });
});

describe("finding skills", () => {
  it("finds every skill folder, nested ones apart, and explains the rest", () => {
    const files = filesFromZip(
      zipOf({
        "skills/SKILL.md": skillMd("root-one"),
        "skills/pdf/SKILL.md": skillMd("pdf"),
        "skills/pdf/scripts/fill.py": "print(1)",
        "skills/pdf/reference.md": "ref",
        "skills/bad/SKILL.md": "no frontmatter",
        "skills/nodesc/SKILL.md": "---\nname: nodesc\n---\n",
        "skills/.system/imagegen/SKILL.md": skillMd("imagegen"),
        "README.md": "outside any skill",
      }),
    );
    expect(files.map((f) => f.path)).not.toContain("README.md");
    const { skills, skipped } = findSkills(files);
    expect(skills.map((s) => s.name)).toEqual(["root-one", "pdf"]);
    const pdf = skills.find((s) => s.name === "pdf")!;
    expect(pdf).toMatchObject({ location: "skills/pdf", files: 3, scripts: 1 });
    // The root skill doesn't swallow the nested ones.
    expect(skills[0]!.files).toBe(1);
    expect(skipped.map((s) => s.location).toSorted()).toEqual(["skills/bad", "skills/nodesc"]);
  });

  it("narrows to a folder or one skill", () => {
    const files = filesFromZip(
      zipOf({
        "repo-HEAD/skills/pdf/SKILL.md": skillMd("pdf"),
        "repo-HEAD/skills/docx/SKILL.md": skillMd("docx"),
      }),
      { stripTop: true },
    );
    expect(findSkills(files, { subPath: "skills/docx" }).skills.map((s) => s.name)).toEqual([
      "docx",
    ]);
    expect(findSkills(files, { only: "pdf" }).skills.map((s) => s.name)).toEqual(["pdf"]);
  });
});

describe("links", () => {
  it("understands GitHub, skills.sh, zips and SKILL.md links", () => {
    expect(resolveSkillLink("github.com/anthropics/skills")).toMatchObject({
      kind: "zip",
      url: "https://codeload.github.com/anthropics/skills/zip/HEAD",
      stripTop: true,
    });
    expect(
      resolveSkillLink("https://github.com/anthropics/skills/tree/main/skills/pdf"),
    ).toMatchObject({
      url: "https://codeload.github.com/anthropics/skills/zip/main",
      subPath: "skills/pdf",
    });
    expect(
      resolveSkillLink("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md"),
    ).toMatchObject({ subPath: "skills/pdf" });
    expect(resolveSkillLink("https://skills.sh/mattpocock/skills/grill-me")).toMatchObject({
      url: "https://codeload.github.com/mattpocock/skills/zip/HEAD",
      only: "grill-me",
    });
    expect(resolveSkillLink("https://example.com/files/my-skill.zip")).toMatchObject({
      kind: "zip",
      stripTop: false,
    });
    expect(resolveSkillLink("https://gist.example.com/me/review/SKILL.md")).toMatchObject({
      kind: "file",
      fallbackName: "review",
    });
    expect(() => resolveSkillLink("http://example.com/a.zip")).toThrow(/https/);
    expect(() => resolveSkillLink("https://example.com/page")).toThrow(/isn't a skill/);
    expect(() => resolveSkillLink("https://skills.sh/site/open.feishu.cn/lark-doc")).toThrow(/zip/);
  });

  it("keeps downloads off this computer's own network", async () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.77.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("140.82.112.3")).toBe(false);
    const never: FetchLike = async () => {
      throw new Error("must not be called");
    };
    await expect(
      fetchCapped("https://evil.example/a.zip", {
        fetchImpl: never,
        resolve: async () => ["10.0.0.5"],
      }),
    ).rejects.toThrow(/own network/);
    // A public host redirecting into the private network is stopped too.
    const redirecting: FetchLike = async () =>
      new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } });
    await expect(
      fetchCapped("https://ok.example/a.zip", {
        fetchImpl: redirecting,
        resolve: async (h) => (h === "ok.example" ? ["93.184.216.34"] : ["169.254.169.254"]),
      }),
    ).rejects.toThrow(/own network/);
  });

  it("stops downloads over the cap", async () => {
    const big: FetchLike = async () => new Response(new Uint8Array(2048));
    await expect(
      fetchCapped("https://ok.example/a.zip", {
        fetchImpl: big,
        resolve: async () => ["93.184.216.34"],
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/bigger/);
  });
});

describe("stage → add", () => {
  it("stages a GitHub link and adds the picked skill without the executable bit", async () => {
    const archive = zipOf({
      "skills-HEAD/skills/pdf/SKILL.md": skillMd("pdf"),
      "skills-HEAD/skills/pdf/scripts/run.sh": "#!/bin/sh\necho hi",
      "skills-HEAD/skills/xlsx/SKILL.md": skillMd("xlsx"),
    });
    const fetchImpl: FetchLike = async (url) => {
      expect(String(url)).toBe("https://codeload.github.com/anthropics/skills/zip/HEAD");
      return new Response(archive);
    };
    const preview = await stageSkills(
      { source: "link", url: "https://github.com/anthropics/skills" },
      { fetchImpl, resolve: async () => ["140.82.112.3"] },
    );
    expect(preview.sourceLabel).toBe("github.com/anthropics/skills");
    expect(preview.skills.map((s) => [s.name, s.scripts])).toEqual([
      ["pdf", 1],
      ["xlsx", 0],
    ]);
    const root = nodePath.join(base(), "home", ".claude", "skills");
    const added = await addStagedSkills({ token: preview.token, keys: ["0"], roots: [root] });
    expect(added).toEqual([{ name: "pdf", paths: [nodePath.join(root, "pdf")] }]);
    const script = nodePath.join(root, "pdf", "scripts", "run.sh");
    expect(readFileSync(script, "utf8")).toContain("echo hi");
    expect(statSync(script).mode & 0o111).toBe(0);
    expect(existsSync(nodePath.join(root, "xlsx"))).toBe(false);
  });

  it("says plainly when there's no skill", async () => {
    const dir = base();
    writeFileSync(nodePath.join(dir, "notes.md"), "hello");
    await expect(stageSkills({ source: "folder", path: dir })).rejects.toThrow(/No skills here/);
  });

  it("takes an uploaded zip in chunks", async () => {
    const bytes = zipOf({
      "my-skills/a/SKILL.md": skillMd("a"),
      "my-skills/b/SKILL.md": skillMd("b"),
    });
    const half = Math.floor(bytes.length / 2);
    const id = `t${Date.now()}`;
    await appendUploadChunk({
      uploadId: id,
      chunk: Buffer.from(bytes.subarray(0, half)).toString("base64"),
      first: true,
    });
    await appendUploadChunk({
      uploadId: id,
      chunk: Buffer.from(bytes.subarray(half)).toString("base64"),
      first: false,
    });
    const preview = await stageSkills({ source: "upload", uploadId: id, name: "my-skills.zip" });
    expect(preview.skills.map((s) => s.name)).toEqual(["a", "b"]);
    await expect(stageSkills({ source: "upload", uploadId: id, name: "again" })).rejects.toThrow(
      /interrupted/,
    );
  });

  it("reads a folder without following links inside it", async () => {
    const dir = base();
    mkdirSync(nodePath.join(dir, "skills", "mine"), { recursive: true });
    writeFileSync(nodePath.join(dir, "skills", "mine", "SKILL.md"), skillMd("mine"));
    const secret = nodePath.join(dir, "secret.txt");
    writeFileSync(secret, "token");
    symlinkSync(secret, nodePath.join(dir, "skills", "mine", "leak.txt"));
    const files = await filesFromFolder(nodePath.join(dir, "skills"));
    expect(files.map((f) => f.path)).toEqual(["mine/SKILL.md"]);
    expect(lstatSync(nodePath.join(dir, "skills", "mine", "leak.txt")).isSymbolicLink()).toBe(true);
  });

  it("forgets an expired or unknown preview", async () => {
    await expect(
      addStagedSkills({ token: "nope", keys: ["0"], roots: ["/tmp/x"] }),
    ).rejects.toThrow(/expired/);
  });
});
