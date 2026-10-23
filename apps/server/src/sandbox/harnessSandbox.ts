/**
 * "This assistant sees only the selected projects" as a real boundary: the
 * harness of a restricted assistant (Claude Code, Codex, Hermes) runs inside
 * bubblewrap (`bwrap`) on a Linux computer.
 *
 * What the harness sees inside (everything else does not exist there):
 *
 * - the system, read-only: `/usr` (and the `/bin`, `/lib*` links to it),
 *   `/etc` minus the files Uno Work and ssh keep secrets in, `/opt` (the
 *   Uno Work bundle, tools), `/sys`, DNS (`/run/systemd/resolve`), a fresh
 *   `/proc` of its own processes only and a minimal `/dev`;
 * - in the person's home, read-only: the places harness CLIs are installed
 *   (`~/.local/bin`, `~/.local/lib`, `~/.local/share/uv`, `~/.local/share/claude`,
 *   `~/.nvm`, `~/.bun`), the Uno SDK (`~/.uno/sdk`) and the git identity
 *   (`~/.gitconfig`, `~/.config/git`). The rest of the home is an empty tmpfs:
 *   other projects, `~/.uno` tokens, `~/.ssh`, other assistants' folders;
 * - read-write: the allowed projects' folders, the assistant's own folder,
 *   the chat's working folder and a private `/tmp` (a folder of the state
 *   disk, not RAM — see deploy/uno-work.service on TMPDIR);
 * - the harness's own state and sign-in, as each harness needs it
 *   ({@link HarnessSandboxExtras}, built in harnessSandboxExtras.ts);
 * - `/var` is an empty tmpfs: the daemon's state (`/var/lib/uno-work`:
 *   settings with the computer's key, every chat's history) is not there.
 *
 * Network is shared (the harness talks to the model and to the daemon's
 * uno-work MCP on localhost). Namespaces: user, pid, ipc, uts;
 * `--die-with-parent`, `--new-session`.
 *
 * The plan comes from the assistant policy (assistants/assistantSandboxPolicy.ts);
 * the harness adapters add their extras and spawn through {@link sandboxedCommand}
 * or {@link spawnSandboxedProcess}.
 *
 * @module sandbox/harnessSandbox
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as nodePath from "node:path";

/** What the assistant policy decided a chat's harness may see. */
export interface HarnessSandboxPlan {
  /** The bubblewrap binary that passed the capability probe. */
  readonly bwrapPath: string;
  /** The person's home (`$HOME` of the daemon). */
  readonly home: string;
  /** The chat's working folder (one of {@link writableDirs}). */
  readonly cwd: string;
  /** Read-write: allowed projects, the assistant's own folder, the chat's folder. */
  readonly writableDirs: ReadonlyArray<string>;
  /**
   * Folders it may not see (other projects, other assistants). Only matters
   * when one sits inside a writable folder: it is hidden there.
   */
  readonly hiddenDirs: ReadonlyArray<string>;
  /** Host folder mounted as `/tmp` (the assistant's own scratch). */
  readonly tmpDir: string;
  /** The assistant (its project id), for messages and logs. */
  readonly assistantProjectId: string;
}

/**
 * One step of what a harness adds to the sandbox, in order (a later step
 * covers an earlier one):
 *
 * - `ro` / `rw`: the host path at the same path inside, when it exists;
 * - `hide`: an existing directory becomes an empty tmpfs, an existing file
 *   reads as empty (`/dev/null`; writes vanish). Missing paths are skipped:
 *   nothing is created on the host.
 */
export type HarnessSandboxMount =
  | { readonly kind: "ro" | "rw"; readonly path: string }
  | { readonly kind: "hide"; readonly path: string };

export interface HarnessSandboxExtras {
  readonly mounts: ReadonlyArray<HarnessSandboxMount>;
  /** Folders to create on the host before the spawn (so their binds exist). */
  readonly ensureDirs?: ReadonlyArray<string>;
}

/** A plan with the harness's extras: what the spawn wraps the command in. */
export interface HarnessSandboxSpec {
  readonly plan: HarnessSandboxPlan;
  readonly extras: HarnessSandboxExtras;
}

/** What {@link buildBwrapArgs} asks about the host's filesystem. */
export type PathInfo =
  | { readonly type: "dir" }
  | { readonly type: "file" }
  | { readonly type: "symlink"; readonly target: string }
  | null;

export type InspectPath = (path: string) => PathInfo;

export const inspectHostPath: InspectPath = (path) => {
  try {
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink()) return { type: "symlink", target: fs.readlinkSync(path) };
    if (stat.isDirectory()) return { type: "dir" };
    return { type: "file" };
  } catch {
    return null;
  }
};

/** `/bin`, `/lib`… — links into `/usr` on a merged-/usr system (Ubuntu 24.04). */
const SYSTEM_TOP_LEVEL = ["/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"] as const;

/** Read-only system trees, when present. */
const SYSTEM_READ_ONLY = ["/usr", "/etc", "/opt", "/sys", "/run/systemd/resolve"] as const;

/** Secrets in `/etc`: Uno Work's env and update config, ssh host keys, sudo rules, password hashes. */
export const SANDBOX_HIDDEN_SYSTEM_PATHS = [
  "/etc/uno-work",
  "/etc/ssh",
  "/etc/sudoers",
  "/etc/sudoers.d",
  "/etc/shadow",
  "/etc/shadow-",
  "/etc/gshadow",
  "/etc/gshadow-",
] as const;

/**
 * Read-only parts of the home: where harness CLIs and their runtimes are
 * installed (deploy/install.sh, provider/setup/harnessInstallCommands.ts),
 * the Uno SDK (`uno`, `git-remote-uno`), the git identity. No credentials:
 * `~/.npmrc`, `~/.config/gh`, `~/.ssh`, `~/.uno` (apart from the SDK) stay out.
 */
export const SANDBOX_HOME_READ_ONLY = [
  ".local/bin",
  ".local/lib",
  ".local/share/uv",
  ".local/share/claude",
  ".nvm",
  ".bun/bin",
  ".uno/sdk",
  ".gitconfig",
  ".config/git",
] as const;

const BWRAP_NAMESPACE_FLAGS = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--die-with-parent",
  "--new-session",
] as const;

/** The same namespaces the real spawn uses: what the capability probe tries. */
export const BWRAP_PROBE_ARGS: ReadonlyArray<string> = [
  ...BWRAP_NAMESPACE_FLAGS,
  "--ro-bind",
  "/",
  "/",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "true",
];

const normalize = (path: string) => nodePath.resolve(path);

/** `inner` is `outer` or inside it. */
export function isSameOrInside(inner: string, outer: string): boolean {
  const relative = nodePath.relative(normalize(outer), normalize(inner));
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

/** `inner` is strictly inside `outer`. */
export function isStrictlyInside(inner: string, outer: string): boolean {
  return isSameOrInside(inner, outer) && normalize(inner) !== normalize(outer);
}

const depth = (path: string) => normalize(path).split(nodePath.sep).filter(Boolean).length;

function unique(paths: ReadonlyArray<string>): string[] {
  return [...new Set(paths.map(normalize))];
}

function hideArgs(path: string, inspect: InspectPath): string[] {
  const info = inspect(path);
  if (info === null) return [];
  if (info.type === "dir") return ["--tmpfs", path];
  // A file (or a link to one): reads empty, writes go nowhere.
  return ["--ro-bind", "/dev/null", path];
}

function bindArgs(kind: "ro" | "rw", path: string, inspect: InspectPath): string[] {
  if (inspect(path) === null) return [];
  return [kind === "ro" ? "--ro-bind" : "--bind", path, path];
}

/**
 * The bwrap arguments (without the command) for a spec. Pure apart from
 * `inspect`, which says what exists on the host.
 */
export function buildBwrapArgs(
  spec: HarnessSandboxSpec,
  inspect: InspectPath = inspectHostPath,
): string[] {
  const { plan, extras } = spec;
  const home = normalize(plan.home);
  const args: string[] = [...BWRAP_NAMESPACE_FLAGS];

  // The system, read-only.
  for (const path of SYSTEM_TOP_LEVEL) {
    const info = inspect(path);
    if (info === null) continue;
    if (info.type === "symlink") args.push("--symlink", info.target, path);
    else args.push("--ro-bind", path, path);
  }
  for (const path of SYSTEM_READ_ONLY) args.push(...bindArgs("ro", path, inspect));
  for (const path of SANDBOX_HIDDEN_SYSTEM_PATHS) args.push(...hideArgs(path, inspect));
  args.push("--proc", "/proc", "--dev", "/dev");

  // Empty home and /var; a private /tmp.
  args.push("--tmpfs", home, "--tmpfs", "/var", "--dir", "/var/tmp");
  args.push("--bind", normalize(plan.tmpDir), "/tmp");

  // Harness CLIs, the SDK, the git identity.
  for (const relative of SANDBOX_HOME_READ_ONLY) {
    args.push(...bindArgs("ro", nodePath.join(home, relative), inspect));
  }

  // The harness's own state and sign-in.
  for (const mount of extras.mounts) {
    if (mount.kind === "hide") args.push(...hideArgs(normalize(mount.path), inspect));
    else args.push(...bindArgs(mount.kind, normalize(mount.path), inspect));
  }

  // The work: parents before children.
  const writable = unique(plan.writableDirs).toSorted((a, b) => depth(a) - depth(b));
  for (const dir of writable) args.push(...bindArgs("rw", dir, inspect));

  // Projects it may not see that sit inside one it may (a project folder
  // nested in another): hidden, then whatever allowed folder lies inside
  // them bound back.
  const hidden = unique(plan.hiddenDirs).filter(
    (dir) => !writable.includes(dir) && writable.some((allowed) => isStrictlyInside(dir, allowed)),
  );
  for (const dir of hidden) {
    args.push(...hideArgs(dir, inspect));
    for (const allowed of writable) {
      if (isStrictlyInside(allowed, dir)) args.push(...bindArgs("rw", allowed, inspect));
    }
  }

  args.push("--setenv", "TMPDIR", "/tmp", "--chdir", normalize(plan.cwd));
  return args;
}

/**
 * Where the command resolves to, when it lives in a part of the host the
 * sandbox hides (the home, /var) and outside the standard install places:
 * its folder is bound read-only so a harness configured with its own binary
 * still starts. Never the home itself.
 */
export function commandMounts(
  command: string,
  input: {
    readonly home: string;
    readonly pathEnv: string | undefined;
    readonly resolve?: (command: string, pathEnv: string | undefined) => string | null;
  },
): HarnessSandboxMount[] {
  const resolved = (input.resolve ?? resolveExecutable)(command, input.pathEnv);
  if (resolved === null) return [];
  const home = normalize(input.home);
  const mounts: HarnessSandboxMount[] = [];
  for (const file of new Set([resolved, realpathOr(resolved)])) {
    const dir = nodePath.dirname(file);
    const hiddenArea = isSameOrInside(dir, home) || isSameOrInside(dir, "/var");
    const covered = SANDBOX_HOME_READ_ONLY.some((relative) =>
      isSameOrInside(dir, nodePath.join(home, relative)),
    );
    if (hiddenArea && !covered && isStrictlyInside(dir, home)) {
      mounts.push({ kind: "ro", path: dir });
    }
  }
  return mounts;
}

function realpathOr(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/** `command` as the shell would find it (an absolute path stays as it is). */
export function resolveExecutable(command: string, pathEnv: string | undefined): string | null {
  if (command.includes("/")) return nodePath.resolve(command);
  for (const dir of (pathEnv ?? "").split(nodePath.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = nodePath.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/** Folders the sandbox binds that must exist on the host first. */
export function prepareSandboxHost(spec: HarnessSandboxSpec): void {
  fs.mkdirSync(spec.plan.tmpDir, { recursive: true, mode: 0o700 });
  for (const dir of spec.extras.ensureDirs ?? []) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * `command args` wrapped in bwrap. `pathEnv` (the harness's PATH) lets a
 * harness binary outside the standard places be bound too.
 */
export function sandboxedCommand(
  spec: HarnessSandboxSpec,
  command: string,
  args: ReadonlyArray<string>,
  pathEnv: string | undefined,
  inspect: InspectPath = inspectHostPath,
): { readonly command: string; readonly args: ReadonlyArray<string> } {
  const extraMounts = commandMounts(command, { home: spec.plan.home, pathEnv });
  const withCommand: HarnessSandboxSpec =
    extraMounts.length === 0
      ? spec
      : {
          plan: spec.plan,
          extras: { ...spec.extras, mounts: [...extraMounts, ...spec.extras.mounts] },
        };
  return {
    command: spec.plan.bwrapPath,
    args: [...buildBwrapArgs(withCommand, inspect), "--", command, ...args],
  };
}

/** The last bytes of a sandboxed harness's stderr, for the log when it fails. */
const STDERR_TAIL_BYTES = 4_096;

/**
 * Node `spawn` of a harness inside the sandbox (the Claude Agent SDK's
 * `spawnClaudeCodeProcess`). stdin/stdout are pipes as the SDK expects;
 * stderr is drained (a full pipe would block the harness) and its tail
 * handed to `onExit` — bwrap's own errors land there.
 */
export function spawnSandboxedProcess(
  spec: HarnessSandboxSpec,
  options: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string | undefined;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly signal?: AbortSignal | undefined;
    readonly onExit?: (code: number | null, stderrTail: string) => void;
  },
): ChildProcessWithoutNullStreams {
  prepareSandboxHost(spec);
  const wrapped = sandboxedCommand(spec, options.command, options.args, options.env.PATH);
  const child = spawn(wrapped.command, [...wrapped.args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.signal ? { signal: options.signal } : {}),
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
  let tail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  });
  child.on("exit", (code) => options.onExit?.(code, tail));
  return child;
}
