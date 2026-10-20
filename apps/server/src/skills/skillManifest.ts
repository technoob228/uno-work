/**
 * What makes a folder a skill: a `SKILL.md` that starts with YAML
 * frontmatter carrying `name` and `description` (the open Agent Skills
 * format Claude Code, Codex and OpenCode all read). Only these two fields
 * matter to Uno Work, so this reads just enough YAML for them: plain,
 * quoted and block (`|`, `>`) scalars at the top level.
 */

export interface SkillManifest {
  readonly name: string | null;
  readonly description: string | null;
}

/** Biggest SKILL.md read when looking for skills (frontmatter is at the top). */
export const SKILL_MD_MAX_BYTES = 512 * 1024;

const FENCE = /^---\s*$/;
const END = /^(---|\.\.\.)\s*$/;
const KEY = /^([A-Za-z_][\w-]*)\s*:(.*)$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\(["\\/])/g, "$1");
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  // A plain scalar ends at " #" (a comment).
  const comment = v.search(/\s#/);
  return (comment >= 0 ? v.slice(0, comment) : v).trim();
}

/** `null` when the file has no frontmatter at all. */
export function parseSkillManifest(text: string): SkillManifest | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (!FENCE.test(lines[0] ?? "")) return null;
  const end = lines.findIndex((line, index) => index > 0 && END.test(line));
  if (end < 0) return null;
  const body = lines.slice(1, end);
  const fields = new Map<string, string>();
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i]!;
    if (/^\s/.test(line) || line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const match = KEY.exec(line);
    if (!match) continue;
    const key = match[1]!;
    const rest = match[2]!.trim();
    // Indented lines after the key belong to it.
    const more: string[] = [];
    while (i + 1 < body.length && (/^\s/.test(body[i + 1]!) || body[i + 1]!.trim() === "")) {
      more.push(body[i + 1]!);
      i += 1;
    }
    while (more.length > 0 && more[more.length - 1]!.trim() === "") more.pop();
    let value: string;
    const block = /^([|>])[+-]?\d*\s*(#.*)?$/.exec(rest);
    if (block) {
      const indent = Math.min(
        ...more.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length),
      );
      const lines = more.map((l) => (l.trim() === "" ? "" : l.slice(indent)));
      value =
        block[1] === "|"
          ? lines.join("\n")
          : lines
              .join("\n")
              .replace(/([^\n])\n(?=[^\n])/g, "$1 ")
              .replace(/\n\n/g, "\n");
    } else if (more.length > 0 && !rest.startsWith('"') && !rest.startsWith("'")) {
      // A plain scalar folded over several lines.
      value = [rest, ...more.map((l) => l.trim())].filter(Boolean).join(" ");
    } else if (more.length > 0) {
      value = unquote([rest, ...more.map((l) => l.trim())].join(" "));
    } else {
      value = unquote(rest);
    }
    if (!fields.has(key)) fields.set(key, value.trim());
  }
  const pick = (key: string) => {
    const value = fields.get(key);
    return value && value.length > 0 ? value : null;
  };
  return { name: pick("name"), description: pick("description") };
}

/**
 * The folder a skill gets: OpenCode only loads a skill whose folder equals
 * its name, lower-case letters, digits and single hyphens, up to 64.
 */
export function skillFolderName(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : null;
}

const SCRIPT_EXTENSIONS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "js",
  "mjs",
  "cjs",
  "ts",
  "rb",
  "pl",
  "php",
  "ps1",
  "bat",
  "cmd",
  "exe",
  "bin",
  "jar",
]);

/** A file an agent could run when it uses the skill. */
export function isScriptPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 && SCRIPT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}
