import { describe, expect, it } from "vitest";

import {
  buildBwrapArgs,
  commandMounts,
  isSameOrInside,
  isStrictlyInside,
  sandboxedCommand,
  type HarnessSandboxPlan,
  type InspectPath,
  type PathInfo,
} from "./harnessSandbox.ts";
import { claudeSandboxExtras } from "./harnessSandboxExtras.ts";

const HOME = "/home/unowork";
const ASSISTANT = `${HOME}/UnoWork/Assistants/ana`;
const SHOP = `${HOME}/projects/shop`;
const NESTED_OTHER = `${SHOP}/vendor-secret`;
const TMP = "/var/lib/uno-work/userdata/sandbox/tmp/assistant-ana";

const PLAN: HarnessSandboxPlan = {
  bwrapPath: "/usr/bin/bwrap",
  home: HOME,
  cwd: SHOP,
  writableDirs: [SHOP, ASSISTANT],
  hiddenDirs: [NESTED_OTHER, `${HOME}/projects/other`],
  tmpDir: TMP,
  assistantProjectId: "assistant-ana",
};

const dir: PathInfo = { type: "dir" };
const file: PathInfo = { type: "file" };

/** An Ubuntu 24.04 cloud computer, as far as the builder asks. */
const HOST: Record<string, PathInfo> = {
  "/bin": { type: "symlink", target: "usr/bin" },
  "/sbin": { type: "symlink", target: "usr/sbin" },
  "/lib": { type: "symlink", target: "usr/lib" },
  "/lib64": { type: "symlink", target: "usr/lib64" },
  "/usr": dir,
  "/etc": dir,
  "/opt": dir,
  "/sys": dir,
  "/run/systemd/resolve": dir,
  "/etc/uno-work": dir,
  "/etc/ssh": dir,
  "/etc/sudoers": file,
  "/etc/sudoers.d": dir,
  "/etc/shadow": file,
  "/etc/gshadow": file,
  [`${HOME}/.local/bin`]: dir,
  [`${HOME}/.local/lib`]: dir,
  [`${HOME}/.local/share/uv`]: dir,
  [`${HOME}/.uno/sdk`]: dir,
  [`${HOME}/.gitconfig`]: file,
  // Present on the host, never bound:
  [`${HOME}/.ssh`]: dir,
  [`${HOME}/.uno`]: dir,
  [`${HOME}/.uno/app-keys`]: dir,
  [`${HOME}/projects/other`]: dir,
  [`${HOME}/.claude`]: dir,
  [`${HOME}/.claude/projects`]: dir,
  [`${HOME}/.claude/history.jsonl`]: file,
  [`${HOME}/.claude/projects/-home-unowork-projects-shop`]: dir,
  [`${HOME}/.claude/projects/-home-unowork-UnoWork-Assistants-ana`]: dir,
  [SHOP]: dir,
  [ASSISTANT]: dir,
  [NESTED_OTHER]: dir,
  [TMP]: dir,
};

const inspect: InspectPath = (path) => HOST[path] ?? null;

const SYSTEM_PREFIX = [
  "--unshare-user",
  "--unshare-pid",
  "--unshare-ipc",
  "--unshare-uts",
  "--die-with-parent",
  "--new-session",
  "--symlink",
  "usr/bin",
  "/bin",
  "--symlink",
  "usr/sbin",
  "/sbin",
  "--symlink",
  "usr/lib",
  "/lib",
  "--symlink",
  "usr/lib64",
  "/lib64",
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind",
  "/etc",
  "/etc",
  "--ro-bind",
  "/opt",
  "/opt",
  "--ro-bind",
  "/sys",
  "/sys",
  "--ro-bind",
  "/run/systemd/resolve",
  "/run/systemd/resolve",
  "--tmpfs",
  "/etc/uno-work",
  "--tmpfs",
  "/etc/ssh",
  "--ro-bind",
  "/dev/null",
  "/etc/sudoers",
  "--tmpfs",
  "/etc/sudoers.d",
  "--ro-bind",
  "/dev/null",
  "/etc/shadow",
  "--ro-bind",
  "/dev/null",
  "/etc/gshadow",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "--tmpfs",
  HOME,
  "--tmpfs",
  "/var",
  "--dir",
  "/var/tmp",
  "--bind",
  TMP,
  "/tmp",
  "--ro-bind",
  `${HOME}/.local/bin`,
  `${HOME}/.local/bin`,
  "--ro-bind",
  `${HOME}/.local/lib`,
  `${HOME}/.local/lib`,
  "--ro-bind",
  `${HOME}/.local/share/uv`,
  `${HOME}/.local/share/uv`,
  "--ro-bind",
  `${HOME}/.uno/sdk`,
  `${HOME}/.uno/sdk`,
  "--ro-bind",
  `${HOME}/.gitconfig`,
  `${HOME}/.gitconfig`,
];

const WORK_SUFFIX = [
  "--bind",
  SHOP,
  SHOP,
  "--bind",
  ASSISTANT,
  ASSISTANT,
  // Another project nested in an allowed one: hidden.
  "--tmpfs",
  NESTED_OTHER,
  "--setenv",
  "TMPDIR",
  "/tmp",
  "--chdir",
  SHOP,
];

describe("buildBwrapArgs", () => {
  it("builds the exact sandbox: system ro, empty home and /var, work rw", () => {
    expect(buildBwrapArgs({ plan: PLAN, extras: { mounts: [] } }, inspect)).toEqual([
      ...SYSTEM_PREFIX,
      ...WORK_SUFFIX,
    ]);
  });

  it("adds Claude's state with other projects' transcripts and history hidden", () => {
    const extras = claudeSandboxExtras({ claudeHome: HOME, workDirs: PLAN.writableDirs });
    expect(buildBwrapArgs({ plan: PLAN, extras }, inspect)).toEqual([
      ...SYSTEM_PREFIX,
      "--bind",
      `${HOME}/.claude`,
      `${HOME}/.claude`,
      "--tmpfs",
      `${HOME}/.claude/projects`,
      "--ro-bind",
      "/dev/null",
      `${HOME}/.claude/history.jsonl`,
      "--bind",
      `${HOME}/.claude/projects/-home-unowork-projects-shop`,
      `${HOME}/.claude/projects/-home-unowork-projects-shop`,
      "--bind",
      `${HOME}/.claude/projects/-home-unowork-UnoWork-Assistants-ana`,
      `${HOME}/.claude/projects/-home-unowork-UnoWork-Assistants-ana`,
      ...WORK_SUFFIX,
    ]);
  });

  it("never binds the person's secrets or the daemon's state", () => {
    const args = buildBwrapArgs(
      {
        plan: PLAN,
        extras: claudeSandboxExtras({ claudeHome: HOME, workDirs: PLAN.writableDirs }),
      },
      inspect,
    );
    const boundSources = args.flatMap((arg, index) =>
      arg === "--bind" || arg === "--ro-bind" ? [args[index + 1]!] : [],
    );
    for (const secret of [
      `${HOME}/.ssh`,
      `${HOME}/.uno`,
      `${HOME}/.uno/app-keys`,
      `${HOME}/.claude.json`,
      `${HOME}/projects/other`,
      "/var/lib/uno-work",
      HOME,
    ]) {
      expect(boundSources).not.toContain(secret);
    }
    // The only thing of /var inside is the assistant's own /tmp.
    expect(boundSources.filter((source) => source.startsWith("/var/"))).toEqual([TMP]);
    // Every bind of the home is an allowed one.
    expect(
      boundSources
        .filter((source) => source.startsWith(`${HOME}/`))
        .every(
          (source) =>
            source.startsWith(`${HOME}/.local/`) ||
            source === `${HOME}/.uno/sdk` ||
            source === `${HOME}/.gitconfig` ||
            source.startsWith(`${HOME}/.claude`) ||
            source === SHOP ||
            source === ASSISTANT,
        ),
    ).toBe(true);
  });

  it("skips what the host doesn't have and binds parents before children", () => {
    const nested = `${SHOP}/packages/app`;
    const args = buildBwrapArgs(
      {
        plan: { ...PLAN, writableDirs: [nested, SHOP], hiddenDirs: [], cwd: nested },
        extras: {
          mounts: [
            { kind: "ro", path: "/nowhere" },
            { kind: "hide", path: "/gone" },
          ],
        },
      },
      (path) => (path === nested ? dir : inspect(path)),
    );
    expect(args).not.toContain("/nowhere");
    expect(args).not.toContain("/gone");
    expect(args.indexOf(SHOP)).toBeLessThan(args.indexOf(nested));
    expect(args.slice(-2)).toEqual(["--chdir", nested]);
  });

  it("hides a forbidden project that holds an allowed one, then binds the allowed one back", () => {
    const outer = `${HOME}/projects/mono`;
    const inner = `${outer}/apps/allowed`;
    const plan = { ...PLAN, writableDirs: [`${HOME}/projects`, inner], hiddenDirs: [outer] };
    const args = buildBwrapArgs({ plan, extras: { mounts: [] } }, () => dir);
    const hideAt = args.indexOf(outer);
    expect(args[hideAt - 1]).toBe("--tmpfs");
    expect(args.lastIndexOf(inner)).toBeGreaterThan(hideAt);
  });
});

describe("sandboxedCommand", () => {
  it("wraps the harness command after --", () => {
    const wrapped = sandboxedCommand(
      { plan: PLAN, extras: { mounts: [] } },
      "hermes",
      ["acp"],
      undefined,
      inspect,
    );
    expect(wrapped.command).toBe("/usr/bin/bwrap");
    expect(wrapped.args.slice(-3)).toEqual(["--", "hermes", "acp"]);
  });

  it("starts bwrap through the plan's launcher (setpriv dropping capabilities)", () => {
    const launcher = ["/usr/bin/setpriv", "--inh-caps=-all", "--ambient-caps=-all", "--"];
    const wrapped = sandboxedCommand(
      { plan: { ...PLAN, launcher }, extras: { mounts: [] } },
      "hermes",
      ["acp"],
      undefined,
      inspect,
    );
    expect(wrapped.command).toBe("/usr/bin/setpriv");
    expect(wrapped.args.slice(0, 4)).toEqual([
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      PLAN.bwrapPath,
    ]);
    expect(wrapped.args.slice(-3)).toEqual(["--", "hermes", "acp"]);
  });
});

const resolveTo = (path: string | null) => () => path;

describe("commandMounts", () => {
  it("binds a harness binary kept somewhere else in the home", () => {
    expect(
      commandMounts("claude", {
        home: HOME,
        pathEnv: "",
        resolve: resolveTo(`${HOME}/tools/claude/bin/claude`),
      }),
    ).toEqual([{ kind: "ro", path: `${HOME}/tools/claude/bin` }]);
  });

  it("adds nothing for the standard places, the system, or the home itself", () => {
    for (const resolved of [`${HOME}/.local/bin/claude`, "/usr/bin/codex", `${HOME}/claude`]) {
      expect(commandMounts("x", { home: HOME, pathEnv: "", resolve: resolveTo(resolved) })).toEqual(
        [],
      );
    }
    expect(commandMounts("x", { home: HOME, pathEnv: "", resolve: resolveTo(null) })).toEqual([]);
  });
});

describe("path helpers", () => {
  it("tells inside from beside", () => {
    expect(isSameOrInside("/a/b", "/a")).toBe(true);
    expect(isSameOrInside("/a", "/a")).toBe(true);
    expect(isSameOrInside("/ab", "/a")).toBe(false);
    expect(isStrictlyInside("/a", "/a")).toBe(false);
    expect(isStrictlyInside("/a/b/c", "/a/b")).toBe(true);
  });
});
