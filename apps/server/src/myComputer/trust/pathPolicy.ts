/**
 * Paths on the person's computer, judged for the trust tiers (`tiers.ts`).
 *
 * Every path a call touches is first resolved ON the computer (`resolver.ts`:
 * symlinks followed, `..` taken physically), then judged here as a plain
 * absolute path: inside an allowed folder, a sensitive place (keys, mail,
 * browsers, the helper's own folder), a temp folder, or outside. A path that
 * couldn't be resolved is treated as outside.
 *
 * macOS and Windows disks ignore case by default: `~/.SSH` IS `~/.ssh`, so
 * comparisons there ignore case too.
 *
 * @module myComputer/trust/pathPolicy
 */
import type { MyComputerTier } from "@t3tools/contracts";

export type PathOp = "read" | "write" | "delete";

export interface PathJudgeContext {
  /** The computer's home folder, real path (`/Users/misha`). */
  readonly home: string;
  /** Allowed folders, real absolute paths. */
  readonly allowed: ReadonlyArray<string>;
  /** Compare ignoring case (macOS, Windows). */
  readonly caseInsensitive: boolean;
}

export interface PathJudgement {
  readonly tier: MyComputerTier;
  readonly reason: string;
}

/** Where agents' own browser keeps its profile: no personal logins in it. */
export const AGENT_BROWSER_PROFILE = "~/.uno-work/agent-browser";

/** What Settings → My computer starts with. */
export const DEFAULT_ALLOWED_FOLDERS: ReadonlyArray<string> = [
  "~/projects",
  "~/Projects",
  "~/Developer",
  "~/code",
  "~/src",
  "~/.claude",
  "~/.codex",
  "~/Uno Work",
  AGENT_BROWSER_PROFILE,
];

/**
 * Never free, whatever folders are allowed (even `~` itself): keys and
 * tokens, mail and messengers, browsers' own profiles, the system's settings,
 * shell start-up files and the helper's folder (its trust lives there).
 * Relative to home unless absolute. System folders need no entry: they are
 * outside the allowed folders (reading asks, changing always asks).
 */
const SENSITIVE_ANY: ReadonlyArray<string> = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".gpg",
  ".kube",
  ".docker",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".config/op",
  ".password-store",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".uno-connect",
  ".claude/.credentials.json",
  ".claude.json",
  ".codex/auth.json",
  "Library/Keychains",
  "Library/Cookies",
  "Library/Mail",
  "Library/Messages",
  "Library/Safari",
  "Library/Accounts",
  "Library/Calendars",
  "Library/Containers/com.apple.mail",
  "Library/Group Containers",
  "Library/Application Support/Google/Chrome",
  "Library/Application Support/Chromium",
  "Library/Application Support/BraveSoftware",
  "Library/Application Support/Firefox",
  "Library/Application Support/Microsoft Edge",
  "Library/Application Support/Arc",
  "Library/Application Support/com.operasoftware.Opera",
  "Library/Application Support/Vivaldi",
  "Library/Application Support/Telegram Desktop",
  "Library/Application Support/Slack",
  "Library/Application Support/discord",
  "Library/Application Support/WhatsApp",
  "Library/Application Support/Signal",
  "Library/Application Support/1Password",
  "Library/Application Support/com.apple.TCC",
  "Library/Application Support/AddressBook",
  "Library/Application Support/Uno Work",
  "Library/Application Support/t3code",
  "/var/db",
  "/private/var/db",
  "/Library/Keychains",
];

/** Reading these is fine; writing them runs code later (hooks, start-up files). */
const SENSITIVE_WRITE: ReadonlyArray<string> = [
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".gitconfig",
  ".config/git",
  ".config/fish",
  "Library/LaunchAgents",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".codex/config.toml",
];

/** Secrets of a project: they don't leave the computer unasked (see bringWork.ts). */
const ENV_FILE = /^\.env(\..+)?$/i;
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist|defaults)$/i;

const TEMP_ROOTS: ReadonlyArray<string> = [
  "/tmp",
  "/private/tmp",
  "/var/folders",
  "/private/var/folders",
];
const DEVICE_FREE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

const fold = (value: string, ctx: PathJudgeContext) =>
  ctx.caseInsensitive ? value.toLowerCase() : value;

/** `a` is `root` or inside it (both absolute, normalized). */
export function isInside(a: string, root: string, caseInsensitive = false): boolean {
  const p = caseInsensitive ? a.toLowerCase() : a;
  const r = trimSlash(caseInsensitive ? root.toLowerCase() : root);
  if (r === "") return true;
  return p === r || p.startsWith(`${r}/`);
}

const trimSlash = (value: string) => (value.length > 1 ? value.replace(/\/+$/, "") : value);

/**
 * `..` and `.` taken lexically, doubled slashes dropped. Only for paths that
 * are already real (resolved on the computer), or that don't exist there.
 */
export function normalizePosix(input: string): string {
  const absolute = input.startsWith("/");
  const parts: Array<string> = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}` || (absolute ? "/" : ".");
}

/** `~`, `~/x`, `$HOME/x`, `${HOME}/x` → under `home`; other `~user` → null. */
export function expandHome(raw: string, home: string): string | null {
  if (raw === "~") return home;
  if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
  if (raw.startsWith("~")) return null;
  if (raw === "$HOME" || raw === "${HOME}") return home;
  if (raw.startsWith("$HOME/")) return `${home}/${raw.slice(6)}`;
  if (raw.startsWith("${HOME}/")) return `${home}/${raw.slice(8)}`;
  return raw;
}

/**
 * An absolute, not yet resolved path: what the resolver gets. Null: can't
 * tell. `expandTilde: false` for a command's words, which the shell parser
 * already expanded: a quoted "~/x" there is a folder named `~`.
 */
export function absoluteRaw(
  raw: string,
  cwd: string,
  home: string,
  expandTilde = true,
): string | null {
  const expanded = expandTilde ? expandHome(raw, home) : raw;
  if (expanded === null) return null;
  if (expanded.startsWith("/")) return expanded;
  return `${trimSlash(cwd)}/${expanded}`;
}

const underHome = (entry: string, home: string) =>
  entry.startsWith("/") ? entry : `${trimSlash(home)}/${entry}`;

function sensitive(real: string, op: PathOp, ctx: PathJudgeContext): string | null {
  for (const entry of SENSITIVE_ANY) {
    if (isInside(real, underHome(entry, ctx.home), ctx.caseInsensitive)) {
      return entry.startsWith("/") ? entry : `~/${entry}`;
    }
  }
  if (op !== "read") {
    for (const entry of SENSITIVE_WRITE) {
      if (isInside(real, underHome(entry, ctx.home), ctx.caseInsensitive)) return `~/${entry}`;
    }
  }
  const name = real.slice(real.lastIndexOf("/") + 1);
  if (op === "read" && ENV_FILE.test(name) && !ENV_EXAMPLE.test(name)) return name;
  return null;
}

/** Something that is never free lives at or under `real` (a folder a glob or `-r` walks). */
export function sensitiveUnder(real: string, ctx: PathJudgeContext): string | null {
  const path = normalizePosix(real);
  for (const entry of SENSITIVE_ANY) {
    const full = underHome(entry, ctx.home);
    if (isInside(full, path, ctx.caseInsensitive) || isInside(path, full, ctx.caseInsensitive)) {
      return entry.startsWith("/") ? entry : `~/${entry}`;
    }
  }
  return null;
}

/** An allowed folder itself, or home: deleting all of it is never routine. */
export function isRootFolder(real: string, ctx: PathJudgeContext): boolean {
  const path = fold(normalizePosix(real), ctx);
  return (
    ctx.allowed.some((root) => fold(trimSlash(root), ctx) === path) ||
    path === fold(trimSlash(ctx.home), ctx) ||
    path === "/"
  );
}

export function insideAllowed(real: string, ctx: PathJudgeContext): boolean {
  return ctx.allowed.some((root) => isInside(real, root, ctx.caseInsensitive));
}

/**
 * The tier of one path operation. `real`: the path as the computer resolved
 * it; null when it couldn't be resolved (then: as outside the folders).
 */
export function judgePath(real: string | null, op: PathOp, ctx: PathJudgeContext): PathJudgement {
  if (real === null) {
    return op === "read"
      ? { tier: "ask", reason: "a path that couldn't be checked" }
      : { tier: "always", reason: "changing a path that couldn't be checked" };
  }
  const path = normalizePosix(real);
  if (DEVICE_FREE.has(path) || path.startsWith("/dev/fd/")) {
    return { tier: "free", reason: "a device" };
  }
  const secret = sensitive(path, op, ctx);
  if (secret !== null) {
    return {
      tier: "always",
      reason: op === "read" ? `reading ${secret}` : `changing ${secret}`,
    };
  }
  if (insideAllowed(path, ctx)) {
    if (op === "read") return { tier: "free", reason: "reading in allowed folders" };
    if (op === "delete" && isRootFolder(path, ctx)) {
      return { tier: "always", reason: `deleting the whole folder ${displayPath(path, ctx.home)}` };
    }
    return {
      tier: "chat",
      reason: op === "delete" ? "deleting in allowed folders" : "writing in allowed folders",
    };
  }
  if (TEMP_ROOTS.some((root) => isInside(path, root, ctx.caseInsensitive))) {
    return op === "read"
      ? { tier: "free", reason: "reading a temp folder" }
      : { tier: "chat", reason: "writing in a temp folder" };
  }
  const shown = displayPath(path, ctx.home);
  if (op === "read") return { tier: "ask", reason: `reading ${shown}, outside allowed folders` };
  return {
    tier: "always",
    reason: `${op === "delete" ? "deleting" : "changing"} ${shown}, outside allowed folders`,
  };
}

/** `/Users/me/x` → `~/x`, for people. */
export function displayPath(real: string, home: string): string {
  const h = trimSlash(home);
  if (real === h) return "~";
  return real.startsWith(`${h}/`) ? `~/${real.slice(h.length + 1)}` : real;
}
