import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  manifestIdFromFileName,
  parseAppPath,
  parseAppUrl,
  parseIconText,
  readIconDataUrl,
  readManifestDir,
  resolveInsideHome,
  validateManifest,
} from "./appManifest.ts";

const HOME = "/home/unowork";
const DIR = "/home/unowork/.uno/apps";
const opts = { home: HOME, manifestDir: DIR };

describe("manifest fields", () => {
  it("accepts short ids and nothing else", () => {
    expect(manifestIdFromFileName("notes.json")).toBe("notes");
    expect(manifestIdFromFileName("My-App_2.json")).toBe("my-app_2");
    expect(manifestIdFromFileName("../evil.json")).toBeNull();
    expect(manifestIdFromFileName(".hidden.json")).toBeNull();
    expect(manifestIdFromFileName("a b.json")).toBeNull();
    expect(manifestIdFromFileName("notes.txt")).toBeNull();
    expect(manifestIdFromFileName(`${"a".repeat(80)}.json`)).toBeNull();
  });

  it("only lets http(s) links through, without credentials", () => {
    expect(parseAppUrl("https://notes.example.com/x")).toBe("https://notes.example.com/x");
    expect(parseAppUrl("javascript:alert(1)")).toBeNull();
    expect(parseAppUrl("data:text/html,<script>")).toBeNull();
    expect(parseAppUrl("file:///etc/passwd")).toBeNull();
    expect(parseAppUrl("https://user:pw@host/")).toBeNull();
    expect(parseAppUrl("https://host/ with space")).toBeNull();
    expect(parseAppUrl(42)).toBeNull();
  });

  it("keeps paths on the app's own port", () => {
    expect(parseAppPath("/admin?tab=1")).toBe("/admin?tab=1");
    expect(parseAppPath("//evil.com/")).toBeNull();
    expect(parseAppPath("https://evil.com")).toBeNull();
    expect(parseAppPath("/a\\b")).toBeNull();
    expect(parseAppPath("/a\u0000b")).toBeNull();
  });

  it("takes an emoji or letters as an icon, never a path or markup", () => {
    expect(parseIconText("📝")).toBe("📝");
    expect(parseIconText("NB")).toBe("NB");
    expect(parseIconText("../../etc/passwd")).toBeNull();
    expect(parseIconText("<img src=x>")).toBeNull();
    expect(parseIconText("C:\\x")).toBeNull();
    expect(parseIconText("a very long icon text")).toBeNull();
  });

  it("keeps a working directory inside home", () => {
    expect(resolveInsideHome("~/projects/notes", HOME)).toBe("/home/unowork/projects/notes");
    expect(resolveInsideHome("projects/notes", HOME)).toBe("/home/unowork/projects/notes");
    expect(resolveInsideHome("/home/unowork/x", HOME)).toBe("/home/unowork/x");
    expect(resolveInsideHome("~/../../etc", HOME)).toBeNull();
    expect(resolveInsideHome("/etc", HOME)).toBeNull();
    expect(resolveInsideHome("/home/unoworkevil", HOME)).toBeNull();
  });
});

describe("validateManifest", () => {
  it("accepts the documented shape", () => {
    const result = validateManifest(
      "notes",
      {
        name: "Notes",
        icon: "📝",
        port: 3000,
        description: "My notes",
        command: "node server.js",
        cwd: "~/projects/notes",
      },
      opts,
    );
    expect(result).toEqual({
      ok: true,
      manifest: {
        id: "notes",
        name: "Notes",
        description: "My notes",
        icon: "📝",
        iconFile: null,
        port: 3000,
        path: null,
        url: null,
        command: "node server.js",
        cwd: "/home/unowork/projects/notes",
        autostart: true,
      },
    });
  });

  it("strips control and bidi characters from the name and falls back to the id", () => {
    const ok = validateManifest("x", { name: "Evil\u202Egnp.exe\u0007", port: 1 }, opts);
    expect(ok.ok && ok.manifest.name).toBe("Evilgnp.exe");
    const fallback = validateManifest("x", { name: "\u0000\u0001", port: 1 }, opts);
    expect(fallback.ok && fallback.manifest.name).toBe("x");
  });

  it("points an icon file into the manifest directory only", () => {
    const file = validateManifest("x", { icon: "notes.png", port: 1 }, opts);
    expect(file.ok && file.manifest.iconFile).toBe(path.join(DIR, "notes.png"));
    const traversal = validateManifest("x", { icon: "../../secret.png", port: 1 }, opts);
    expect(traversal.ok && traversal.manifest.iconFile).toBeNull();
    expect(traversal.ok && traversal.manifest.icon).toBeNull();
  });

  it("rejects junk", () => {
    expect(validateManifest("x", null, opts).ok).toBe(false);
    expect(validateManifest("x", [1, 2], opts).ok).toBe(false);
    expect(validateManifest("x", { name: "no way to reach it" }, opts).ok).toBe(false);
    expect(validateManifest("x", { port: 0 }, opts).ok).toBe(false);
    expect(validateManifest("x", { port: 70000 }, opts).ok).toBe(false);
    expect(validateManifest("x", { port: "3000abc" }, opts).ok).toBe(false);
    expect(validateManifest("x", { url: "javascript:alert(1)" }, opts).ok).toBe(false);
    expect(validateManifest("x", { port: 1, cwd: "/etc" }, opts).ok).toBe(false);
  });

  it("does not autostart without a command, and respects an explicit false", () => {
    const noCommand = validateManifest("x", { port: 1 }, opts);
    expect(noCommand.ok && noCommand.manifest.autostart).toBe(false);
    const off = validateManifest("x", { port: 1, command: "x", autostart: false }, opts);
    expect(off.ok && off.manifest.autostart).toBe(false);
  });
});

describe("readManifestDir", () => {
  let root: string;
  let dir: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "uno-apps-"));
    dir = path.join(root, ".uno", "apps");
    await mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads good manifests and reports bad ones without failing", async () => {
    await writeFile(path.join(dir, "notes.json"), JSON.stringify({ name: "Notes", port: 3000 }));
    await writeFile(path.join(dir, "broken.json"), "{not json");
    await writeFile(path.join(dir, "empty.json"), JSON.stringify({ name: "x" }));
    await writeFile(path.join(dir, "big.json"), JSON.stringify({ port: 1, pad: "x".repeat(40_000) }));
    await writeFile(path.join(dir, "Bad Name.json"), "{}");
    await writeFile(path.join(dir, "notes.log"), "not a manifest");
    await writeFile(path.join(root, "outside.json"), JSON.stringify({ port: 2 }));
    await symlink(path.join(root, "outside.json"), path.join(dir, "link.json"));

    const { manifests, warnings } = await readManifestDir({ manifestDir: dir, home: root });
    expect(manifests.map((m) => m.id)).toEqual(["notes"]);
    expect(warnings).toHaveLength(5);
    expect(warnings.join("\n")).toMatch(/broken\.json: not valid JSON/);
    expect(warnings.join("\n")).toMatch(/link\.json: not a regular file/);
  });

  it("answers an empty list when the folder does not exist", async () => {
    expect(await readManifestDir({ manifestDir: path.join(root, "nope"), home: root })).toEqual({
      manifests: [],
      warnings: [],
    });
  });

  it("accepts a real icon file and refuses a symlinked one", async () => {
    await writeFile(path.join(dir, "notes.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(root, "secret.png"), "secret");
    await symlink(path.join(root, "secret.png"), path.join(dir, "evil.png"));
    await writeFile(path.join(dir, "notes.json"), JSON.stringify({ icon: "notes.png", port: 1 }));
    await writeFile(path.join(dir, "evil.json"), JSON.stringify({ icon: "evil.png", port: 2 }));

    const { manifests, warnings } = await readManifestDir({ manifestDir: dir, home: root });
    const notes = manifests.find((m) => m.id === "notes");
    const evil = manifests.find((m) => m.id === "evil");
    expect(notes?.iconFile).toBe(path.join(dir, "notes.png"));
    expect(evil?.iconFile).toBeNull();
    expect(warnings.some((w) => w.startsWith("evil.json"))).toBe(true);
    expect(await readIconDataUrl(notes!.iconFile!)).toBe("data:image/png;base64,iVBORw==");
  });
});
