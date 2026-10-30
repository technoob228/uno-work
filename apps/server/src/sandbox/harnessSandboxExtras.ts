/**
 * What each harness needs inside the assistant sandbox besides the work
 * folders (harnessSandbox.ts): its state and the person's sign-in. These
 * are the parts that stay visible to a restricted assistant — the residual
 * risk of the boundary:
 *
 * - Claude Code: `~/.claude` read-write — the sign-in (`.credentials.json`,
 *   rewritten on every token refresh, so the folder is bound, not the file),
 *   the person's settings, skills, agents, plugins. Hidden inside it: other
 *   projects' transcripts (`projects/` shows only the sandbox's own folders),
 *   prompt history, file backups of edits, todos, shell snapshots, config
 *   backups. `~/.claude.json` (every project's settings and MCP servers) is
 *   not there: Claude starts with an empty one in the sandbox's home.
 * - Codex: its home (`~/.codex` or the configured one) read-write — the
 *   sign-in (`auth.json`), config, and its session store, which holds
 *   transcripts of other projects too (one SQLite index, can't be split);
 *   prompt history hidden.
 * - Hermes: the chat's own `HERMES_HOME` and the shared Hermes home it links
 *   into (runtime installs, the ChatGPT sign-in, the Claude plugin); other
 *   chats' homes (`threads/`) and the shared home's own history are hidden.
 *   On the person's Claude plan Hermes runs Claude Code, so Claude's part
 *   comes with it.
 *
 * @module sandbox/harnessSandboxExtras
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";

import type { HarnessSandboxExtras, HarnessSandboxMount } from "./harnessSandbox.ts";

/** Claude Code's folder for a working directory's sessions (`~/.claude/projects/<this>`). */
export function claudeProjectDirName(cwd: string): string {
  return nodePath.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-");
}

/** In `~/.claude`, what tells about other projects (hidden inside the sandbox). */
export const CLAUDE_HIDDEN_ENTRIES = [
  "projects",
  "history.jsonl",
  "file-history",
  "todos",
  "shell-snapshots",
  "session-env",
  "paste-cache",
  "backups",
  "debug",
] as const;

export function claudeSandboxExtras(input: {
  /** The HOME Claude runs with (the person's, or the instance's `homePath`). */
  readonly claudeHome: string;
  /** A second account's `CLAUDE_CONFIG_DIR`: there instead of `<claudeHome>/.claude`. */
  readonly configDir?: string | null | undefined;
  /** Folders whose sessions it may keep: the sandbox's writable folders. */
  readonly workDirs: ReadonlyArray<string>;
}): HarnessSandboxExtras {
  const dotClaude = input.configDir?.trim() || nodePath.join(input.claudeHome, ".claude");
  const projects = nodePath.join(dotClaude, "projects");
  const sessionDirs = [...new Set(input.workDirs.map(claudeProjectDirName))].map((name) =>
    nodePath.join(projects, name),
  );
  return {
    ensureDirs: [dotClaude, projects, ...sessionDirs],
    mounts: [
      { kind: "rw", path: dotClaude },
      ...CLAUDE_HIDDEN_ENTRIES.map(
        (name): HarnessSandboxMount => ({ kind: "hide", path: nodePath.join(dotClaude, name) }),
      ),
      ...sessionDirs.map((path): HarnessSandboxMount => ({ kind: "rw", path })),
    ],
  };
}

/** Targets of the symlinks at the top of `dir` (Codex's auth overlay home links into the shared one). */
export function topLevelLinkTargets(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const targets: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) continue;
    try {
      targets.push(fs.realpathSync(nodePath.join(dir, entry.name)));
    } catch {
      // A dangling link: nothing to bind.
    }
  }
  return targets;
}

export function codexSandboxExtras(input: {
  readonly codexHome: string;
  /** Where the home's own links point (see {@link topLevelLinkTargets}). */
  readonly linkTargets?: ReadonlyArray<string>;
}): HarnessSandboxExtras {
  return {
    ensureDirs: [input.codexHome],
    mounts: [
      { kind: "rw", path: input.codexHome },
      ...(input.linkTargets ?? []).map((path): HarnessSandboxMount => ({ kind: "rw", path })),
      { kind: "hide", path: nodePath.join(input.codexHome, "history.jsonl") },
    ],
  };
}

/** In the shared Hermes home: other chats and its own history. */
export const HERMES_SHARED_HIDDEN_ENTRIES = [
  "threads",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "sessions",
  "logs",
  "memories",
] as const;

export function hermesSandboxExtras(input: {
  readonly threadHome: string;
  /** The shared home the chat's home links into (`<stateDir>/hermes-home-<instance>`). */
  readonly sharedHome: string;
  /** Skills Hermes reads (`skills.external_dirs`). */
  readonly skillsDirs: ReadonlyArray<string>;
  /** On the person's Claude plan: Claude Code's part too. */
  readonly claude?: Parameters<typeof claudeSandboxExtras>[0];
}): HarnessSandboxExtras {
  const claude = input.claude ? claudeSandboxExtras(input.claude) : null;
  return {
    ensureDirs: [input.threadHome, ...(claude?.ensureDirs ?? [])],
    mounts: [
      { kind: "rw", path: input.sharedHome },
      ...HERMES_SHARED_HIDDEN_ENTRIES.map(
        (name): HarnessSandboxMount => ({
          kind: "hide",
          path: nodePath.join(input.sharedHome, name),
        }),
      ),
      { kind: "rw", path: input.threadHome },
      ...input.skillsDirs.map((path): HarnessSandboxMount => ({ kind: "ro", path })),
      ...(claude?.mounts ?? []),
    ],
  };
}
