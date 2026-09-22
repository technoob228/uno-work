/**
 * `~/.uno/apps/<id>.json` — the contract for "I made an app, show it on the
 * desktop". A person or an agent writes one small file:
 *
 *   {
 *     "name": "Notes",
 *     "icon": "📝",                 // emoji, or a png/svg/jpg/webp file next to the manifest
 *     "port": 3000,                 // where it listens on this machine
 *     "path": "/",                  // optional: what to open on that port
 *     "url": "https://…",           // optional: an address it already has
 *     "description": "My notes",
 *     "command": "node server.js",  // optional: how to start it
 *     "cwd": "~/projects/notes",    // optional: where to run the command (inside home)
 *     "autostart": true             // optional: start it when the computer starts (default with a command)
 *   }
 *
 * Everything in the file is untrusted text written by whoever can write to the
 * home directory, and it ends up on the desktop and in links. So: names are
 * stripped of control characters, links are http(s) only, an icon file must
 * be a plain image inside the manifest directory, and a working directory
 * must stay inside home.
 */
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_MAX_BYTES = 32 * 1024;
export const MANIFEST_MAX_FILES = 200;
export const ICON_MAX_BYTES = 128 * 1024;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ICON_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(png|svg|jpe?g|webp|gif)$/i;
const ICON_MIME: Record<string, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
// C0/C1 controls and the bidi overrides that can make a name read backwards.
// oxlint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const HAS_UNSAFE_TEXT_RE = new RegExp(UNSAFE_TEXT_RE.source);

export interface AppManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** Emoji / short text icon. */
  readonly icon: string | null;
  /** Absolute path of a validated icon image inside the manifest directory. */
  readonly iconFile: string | null;
  readonly port: number | null;
  readonly path: string | null;
  readonly url: string | null;
  readonly command: string | null;
  /** Absolute, inside home. */
  readonly cwd: string | null;
  readonly autostart: boolean;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: AppManifest }
  | { readonly ok: false; readonly reason: string };

export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(UNSAFE_TEXT_RE, "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return Array.from(text).slice(0, max).join("");
}

/** `"📝"`, `"N"`, `"AB"` — a few visible characters, nothing that looks like a path or markup. */
export function parseIconText(value: string): string | null {
  const text = cleanText(value, 16);
  if (!text) return null;
  if (/[<>/\\:"'`]|\.\./.test(text)) return null;
  // Graphemes are hard; code points are a fair bound for "an emoji or two letters".
  if (Array.from(text).length > 8) return null;
  return text;
}

/** Only http(s), no credentials, no whitespace. */
export function parseAppUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  const raw = value.trim();
  if (raw.length === 0 || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  return url.toString();
}

/** A path on the app's own port: `/`, `/admin?x=1`. Never `//host` or a scheme. */
export function parseAppPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 300) return null;
  if (!raw.startsWith("/") || raw.startsWith("//") || /[\\\s]/.test(raw)) return null;
  if (HAS_UNSAFE_TEXT_RE.test(raw)) return null;
  return raw;
}

export function parsePortValue(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65_535 ? n : null;
}

/** `~/x`, `x` (relative to home) or an absolute path — as long as it stays inside home. */
export function resolveInsideHome(value: unknown, home: string): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0 || raw.length > 1024 || raw.includes("\0")) return null;
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  const absolute = path.resolve(home, expanded);
  const relative = path.relative(home, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return absolute;
}

export function manifestIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  const id = fileName.slice(0, -".json".length).toLowerCase();
  return ID_RE.test(id) ? id : null;
}

/**
 * Validates a parsed manifest. `iconFileExists` answers for an icon file name
 * already known to be a safe basename; the caller does the filesystem checks.
 */
export function validateManifest(
  id: string,
  raw: unknown,
  options: { readonly home: string; readonly manifestDir: string },
): ManifestResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "is not a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const port = record["port"] === undefined ? null : parsePortValue(record["port"]);
  if (record["port"] !== undefined && port === null) {
    return { ok: false, reason: "has a port that isn't a number between 1 and 65535" };
  }
  const url = record["url"] === undefined ? null : parseAppUrl(record["url"]);
  if (record["url"] !== undefined && url === null) {
    return { ok: false, reason: "has a url that isn't an http(s) address" };
  }
  const command =
    typeof record["command"] === "string" &&
    record["command"].trim().length > 0 &&
    record["command"].length <= 2000 &&
    !record["command"].includes("\0")
      ? record["command"].trim()
      : null;
  if (port === null && url === null && command === null) {
    return { ok: false, reason: "needs a port, a url or a command" };
  }
  const cwd = record["cwd"] === undefined ? null : resolveInsideHome(record["cwd"], options.home);
  if (record["cwd"] !== undefined && cwd === null) {
    return { ok: false, reason: "has a cwd outside the home folder" };
  }

  let icon: string | null = null;
  let iconFile: string | null = null;
  if (typeof record["icon"] === "string") {
    const value = record["icon"].trim();
    if (ICON_FILE_RE.test(value)) {
      iconFile = path.join(options.manifestDir, value);
    } else {
      icon = parseIconText(value);
    }
  }

  return {
    ok: true,
    manifest: {
      id,
      name: cleanText(record["name"], 60) ?? id,
      description: cleanText(record["description"], 200),
      icon,
      iconFile,
      port,
      path: parseAppPath(record["path"]),
      url,
      command,
      cwd,
      autostart: typeof record["autostart"] === "boolean" ? record["autostart"] : command !== null,
    },
  };
}

export interface ManifestScan {
  readonly manifests: ReadonlyArray<AppManifest>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Reads every `<id>.json` in the directory. Symlinks, oversized files and
 * invalid JSON become warnings, never exceptions: one broken manifest must
 * not hide the rest of the desktop.
 */
export async function readManifestDir(options: {
  readonly manifestDir: string;
  readonly home: string;
}): Promise<ManifestScan> {
  let names: string[];
  try {
    names = await readdir(options.manifestDir);
  } catch {
    return { manifests: [], warnings: [] };
  }
  const manifests: AppManifest[] = [];
  const warnings: string[] = [];
  for (const fileName of names.toSorted().slice(0, MANIFEST_MAX_FILES)) {
    if (!fileName.endsWith(".json")) continue;
    const id = manifestIdFromFileName(fileName);
    if (!id) {
      warnings.push(`${fileName}: the file name must be a short id like "notes.json".`);
      continue;
    }
    const filePath = path.join(options.manifestDir, fileName);
    try {
      const info = await lstat(filePath);
      if (!info.isFile()) {
        warnings.push(`${fileName}: not a regular file (symlinks are ignored).`);
        continue;
      }
      if (info.size > MANIFEST_MAX_BYTES) {
        warnings.push(`${fileName}: larger than ${MANIFEST_MAX_BYTES / 1024} KB.`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(filePath, "utf8"));
      } catch {
        warnings.push(`${fileName}: not valid JSON.`);
        continue;
      }
      const result = validateManifest(id, parsed, options);
      if (!result.ok) {
        warnings.push(`${fileName}: ${result.reason}.`);
        continue;
      }
      let manifest = result.manifest;
      if (manifest.iconFile && !(await isSafeIconFile(manifest.iconFile, options.manifestDir))) {
        warnings.push(`${fileName}: the icon file is missing, too big or outside the apps folder.`);
        manifest = { ...manifest, iconFile: null };
      }
      manifests.push(manifest);
    } catch {
      warnings.push(`${fileName}: couldn't be read.`);
    }
  }
  return { manifests, warnings };
}

async function isSafeIconFile(iconFile: string, manifestDir: string): Promise<boolean> {
  try {
    const info = await lstat(iconFile);
    if (!info.isFile() || info.size > ICON_MAX_BYTES) return false;
    const [realIcon, realDir] = await Promise.all([realpath(iconFile), realpath(manifestDir)]);
    return path.dirname(realIcon) === realDir;
  } catch {
    return false;
  }
}

/** The icon image as a `data:` URL for an `<img>` (where SVG scripts do not run). */
export async function readIconDataUrl(iconFile: string): Promise<string | null> {
  const ext = path.extname(iconFile).slice(1).toLowerCase();
  const mime = ICON_MIME[ext];
  if (!mime) return null;
  try {
    const bytes = await readFile(iconFile);
    if (bytes.length > ICON_MAX_BYTES) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
