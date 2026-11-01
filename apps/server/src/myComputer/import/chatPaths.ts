/**
 * Where chats live on the person's computer, and the allow-list every read goes
 * through. Only session files: logins (`.credentials.json`, `auth.json`, the
 * keychain, OpenCode's `credential` table) are never read, and no other path
 * ever reaches the helper from the import.
 *
 * @module myComputer/import/chatPaths
 */

export type ComputerOs = "posix" | "windows";

export interface ChatEnvironment {
  readonly claudeConfigDir: string | null;
  readonly codexHome: string | null;
  readonly xdgDataHome: string | null;
  readonly hasSqlite3: boolean;
  readonly hasOpenCode: boolean;
}

export interface ChatRoots {
  readonly os: ComputerOs;
  /** `<config>/projects`: one folder per project, sessions inside. */
  readonly claudeProjects: string;
  /** `<home>/sessions`: `YYYY/MM/DD/rollout-*.jsonl[.zst]`. */
  readonly codexSessions: string;
  readonly codexIndex: string;
  readonly openCodeDb: string;
}

const separatorOf = (os: ComputerOs) => (os === "windows" ? "\\" : "/");

export function joinPath(os: ComputerOs, base: string, ...parts: ReadonlyArray<string>): string {
  const separator = separatorOf(os);
  const trimmed = base.replace(/[\\/]+$/, "");
  return [trimmed, ...parts].join(separator);
}

export const osOf = (name: unknown): ComputerOs => (name === "windows" ? "windows" : "posix");

/**
 * The defaults are the same on macOS, Linux and Windows: all three programs
 * keep to the home folder, OpenCode included (it follows XDG everywhere).
 */
export function resolveChatRoots(input: {
  readonly os: ComputerOs;
  readonly home: string;
  readonly env: ChatEnvironment;
}): ChatRoots {
  const { os, home, env } = input;
  const claudeConfig = env.claudeConfigDir ?? joinPath(os, home, ".claude");
  const codexHome = env.codexHome ?? joinPath(os, home, ".codex");
  const dataHome = env.xdgDataHome ?? joinPath(os, home, ".local", "share");
  return {
    os,
    claudeProjects: joinPath(os, claudeConfig, "projects"),
    codexSessions: joinPath(os, codexHome, "sessions"),
    codexIndex: joinPath(os, codexHome, "session_index.jsonl"),
    openCodeDb: joinPath(os, dataHome, "opencode", "opencode.db"),
  };
}

/** Prints what the import must know from the person's shell, one `key=value` a line. */
export function environmentProbe(os: ComputerOs): string {
  if (os === "windows") {
    return [
      '"claude=$env:CLAUDE_CONFIG_DIR"',
      '"codex=$env:CODEX_HOME"',
      '"xdg=$env:XDG_DATA_HOME"',
      '"sqlite3=$((Get-Command sqlite3 -ErrorAction SilentlyContinue).Source)"',
      '"opencode=$((Get-Command opencode -ErrorAction SilentlyContinue).Source)"',
    ].join("; ");
  }
  return `printf 'claude=%s\\ncodex=%s\\nxdg=%s\\nsqlite3=%s\\nopencode=%s\\n' "\${CLAUDE_CONFIG_DIR:-}" "\${CODEX_HOME:-}" "\${XDG_DATA_HOME:-}" "$(command -v sqlite3 || true)" "$(command -v opencode || true)"`;
}

export function parseEnvironmentProbe(output: string): ChatEnvironment {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const value = (key: string) => {
    const found = values.get(key);
    return found === undefined || found.length === 0 ? null : found;
  };
  return {
    claudeConfigDir: value("claude"),
    codexHome: value("codex"),
    xdgDataHome: value("xdg"),
    hasSqlite3: value("sqlite3") !== null,
    hasOpenCode: value("opencode") !== null,
  };
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const CLAUDE_SESSION_NAME = new RegExp(`^(${UUID})\\.jsonl$`);
const CODEX_SESSION_NAME = new RegExp(
  `^rollout-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-(${UUID})\\.jsonl(?:\\.zst)?$`,
);
const CLAUDE_SESSION_PATH = new RegExp(`[\\\\/]projects[\\\\/][^\\\\/]+[\\\\/]${UUID}\\.jsonl$`);
const CODEX_SESSION_PATH = new RegExp(
  `[\\\\/]sessions[\\\\/]\\d{4}[\\\\/]\\d{2}[\\\\/]\\d{2}[\\\\/]rollout-[^\\\\/]+\\.jsonl(?:\\.zst)?$`,
);
const CODEX_INDEX_PATH = /[\\/]session_index\.jsonl$/;

/** The session id in a Claude Code file name, or null when it is not a session. */
export function claudeSessionId(fileName: string): string | null {
  return CLAUDE_SESSION_NAME.exec(fileName)?.[1] ?? null;
}

/** The thread id in a Codex file name, or null when it is not a session. */
export function codexSessionId(fileName: string): string | null {
  return CODEX_SESSION_NAME.exec(fileName)?.[1] ?? null;
}

export const isZstdPath = (path: string) => path.endsWith(".zst");

/** Whether the import may read this file at all. */
export function isChatFilePath(path: string): boolean {
  if (path.split(/[\\/]/).includes("..")) return false;
  return (
    CLAUDE_SESSION_PATH.test(path) || CODEX_SESSION_PATH.test(path) || CODEX_INDEX_PATH.test(path)
  );
}

export function isChatSessionPath(path: string): boolean {
  return isChatFilePath(path) && !CODEX_INDEX_PATH.test(path);
}

/** A file on this list can't be a session, whatever a path trick makes it look like. */
export class ChatPathRefused extends Error {
  constructor(path: string) {
    super(`Refused to read ${path}: not a chat session file.`);
    this.name = "ChatPathRefused";
  }
}

export function assertChatFilePath(path: string): void {
  if (!isChatFilePath(path)) throw new ChatPathRefused(path);
}

/** Apps that run these CLIs: `stat` only, the name of the app is all we keep. */
export function appMarkers(input: {
  readonly os: ComputerOs;
  readonly home: string;
}): ReadonlyArray<{ readonly name: string; readonly paths: ReadonlyArray<string> }> {
  const { os, home } = input;
  const inHome = (...parts: ReadonlyArray<string>) => joinPath(os, home, ...parts);
  if (os === "windows") {
    const roaming = (name: string) => inHome("AppData", "Roaming", name);
    return [
      { name: "T3 Code", paths: [inHome(".t3"), roaming("t3code-v2")] },
      { name: "Orca", paths: [inHome(".orca"), roaming("Orca")] },
      { name: "bb", paths: [inHome(".bb")] },
    ];
  }
  const support = (name: string) => inHome("Library", "Application Support", name);
  return [
    {
      name: "T3 Code",
      paths: [inHome(".t3"), support("t3code-v2"), inHome(".config", "t3code-v2")],
    },
    {
      name: "Orca",
      paths: [
        inHome(".orca"),
        "/Applications/Orca.app",
        support("Orca"),
        inHome(".config", "Orca"),
      ],
    },
    { name: "bb", paths: [inHome(".bb"), "/Applications/bb.app"] },
  ];
}
