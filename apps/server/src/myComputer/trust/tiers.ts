/**
 * The trust tier of a command line or a file operation on the person's
 * computer (`MyComputerTier`), decided by code before anything runs.
 *
 * A command line is split into simple commands (`shellParse.ts`); each gets a
 * tier, every `$(…)` / backtick / `sh -c` / `eval` / `xargs` / `find -exec`
 * body is judged as a command line of its own, and the line takes the
 * highest. Paths are judged after the computer resolved them (`pathPolicy.ts`,
 * `resolver.ts`): the judge runs twice, first to learn which paths it needs,
 * then with their real paths.
 *
 * The rule for what it doesn't know: "asks" — never "free". The tables below
 * only ever lift a command to `free` / `chat` when they know it.
 *
 * @module myComputer/trust/tiers
 */
import type { MyComputerTier } from "@t3tools/contracts";

import {
  AGENT_BROWSER_PROFILE,
  absoluteRaw,
  displayPath,
  expandHome,
  isInside,
  isRootFolder,
  judgePath,
  normalizePosix,
  sensitiveUnder,
  type PathJudgeContext,
  type PathOp,
} from "./pathPolicy.ts";
import { assignmentName, parseShell, type Segment, type Word } from "./shellParse.ts";

export interface TierResult {
  readonly tier: MyComputerTier;
  /** A few words for the person and the agent: "git push", "reading ~/.ssh". */
  readonly reason: string;
}

const ORDER: Record<MyComputerTier, number> = { free: 0, chat: 1, ask: 2, always: 3, blocked: 4 };

export const higher = (a: TierResult, b: TierResult): TierResult =>
  ORDER[b.tier] > ORDER[a.tier] ? b : a;

export const tierAtLeast = (tier: MyComputerTier, floor: MyComputerTier) =>
  ORDER[tier] >= ORDER[floor];

const r = (tier: MyComputerTier, reason: string): TierResult => ({ tier, reason });
const FREE = r("free", "reading and checking");

/** What a path costs: the computer's answer for each absolute raw path. */
export interface PathFacts {
  /** The real path, or null: it couldn't be resolved. */
  readonly real: (raw: string) => string | null;
  /** The folder is a monorepo root (turbo, workspaces, Cargo workspace, go.work); null: unknown. */
  readonly monorepo: (raw: string) => boolean | null;
}

export interface TierContext extends PathJudgeContext {
  /** The command's folder, absolute, as given (not resolved). */
  readonly cwd: string;
  readonly facts: PathFacts;
  /** Settings → My computer: command starts that run with a chat's Allow. */
  readonly allowedCommands: ReadonlyArray<string>;
}

export const BLOCKED_CONTAINERS =
  "Containers and virtual machines don't run on the person's computer (their rule). Run it on this cloud computer or a temporary Uno machine instead.";
export const BLOCKED_FULL_RUN =
  "Full test runs and benchmarks don't run on the person's computer (their rule): run one package or one file there (a --filter or a path), or run the whole suite on this cloud computer.";

// ── Program tables ─────────────────────────────────────────────────────

const CONTAINER_PROGRAMS = new Set([
  "docker",
  "docker-compose",
  "dockerd",
  "podman",
  "podman-compose",
  "colima",
  "lima",
  "limactl",
  "nerdctl",
  "orb",
  "orbctl",
  "orbstack",
  "multipass",
  "vagrant",
  "vboxmanage",
  "virtualbox",
  "prlctl",
  "utmctl",
  "tart",
  "kind",
  "minikube",
  "k3d",
  "k3s",
  "lxc",
  "lxd",
  "finch",
  "rdctl",
  "container",
  "qemu-img",
]);
const CONTAINER_APPS =
  /^(docker|orbstack|utm|virtualbox|parallels desktop|vmware fusion|multipass|podman desktop|rancher desktop)(\.app)?$/i;

/** Only print or wait: no folder, no paths. */
const PURE = new Set([
  "echo",
  "printf",
  "true",
  "false",
  ":",
  "date",
  "cal",
  "sleep",
  "uname",
  "sw_vers",
  "whoami",
  "id",
  "hostname",
  "uptime",
  "pwd",
  "which",
  "whereis",
  "type",
  "seq",
  "expr",
  "bc",
  "test",
  "[",
  "[[",
  "basename",
  "dirname",
  "exit",
  "return",
  "break",
  "continue",
  "wait",
  "jobs",
  "set",
  "shopt",
  "setopt",
  "unset",
  "ulimit",
  "say",
  "nproc",
  "arch",
  "locale",
  "tty",
  "clear",
]);

/** Read the files they are given (or the current folder). */
const READERS = new Set([
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "tree",
  "ls",
  "jq",
  "yq",
  "uniq",
  "cut",
  "tr",
  "diff",
  "cmp",
  "comm",
  "md5",
  "md5sum",
  "shasum",
  "sha1sum",
  "sha256sum",
  "realpath",
  "readlink",
  "xxd",
  "hexdump",
  "od",
  "strings",
  "otool",
  "nm",
  "lipo",
  "column",
  "fold",
  "nl",
  "rev",
  "tac",
  "paste",
  "join",
  "fmt",
  "iconv",
  "base64",
  "lsof",
  "ps",
  "mdls",
  "dwarfdump",
  "plutil",
  "zcat",
  "bat",
  "eza",
  "exa",
  "fd",
  "shellcheck",
  "tsc-files",
]);
/** Read whole folders: a folder with something sensitive inside always asks. */
const RECURSIVE_READERS = new Set(["rg", "ag", "ack", "fd", "tree", "du"]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
const INTERPRETERS = new Set([
  "node",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "lua",
  "tsx",
  "ts-node",
  "deno",
  "osascript",
  "jxa",
  "Rscript",
  "julia",
  "irb",
]);

/** The person's personal browsers: their logins live there. */
const BROWSER_PROGRAMS = new Set([
  "google chrome",
  "google-chrome",
  "google-chrome-stable",
  "chrome",
  "chromium",
  "chromium-browser",
  "brave",
  "brave browser",
  "microsoft edge",
  "msedge",
  "firefox",
  "safari",
  "arc",
  "opera",
  "vivaldi",
]);
const BROWSER_APPS =
  /^(google chrome|chromium|brave browser|microsoft edge|firefox|safari|arc|opera|vivaldi|google chrome canary)(\.app)?$/i;
const PERSONAL_APPS =
  /^(mail|messages|facetime|contacts|calendar|telegram|whatsapp|slack|discord|signal|skype|zoom\.us|microsoft outlook|spark|airmail|system settings|system preferences|keychain access|1password.*|terminal|iterm|iterm2|wallet|app store|shortcuts|automator|script editor|finder)(\.app)?$/i;

/** Each always asks, whatever they're given. */
const ALWAYS_PROGRAMS: Record<string, string> = {
  sudo: "sudo",
  su: "su",
  doas: "doas",
  osascript: "AppleScript (it can drive any app)",
  shortcuts: "running a Shortcut",
  automator: "running an Automator workflow",
  security: "the keychain",
  scutil: "system settings",
  networksetup: "network settings",
  systemsetup: "system settings",
  pmset: "power settings",
  nvram: "firmware settings",
  csrutil: "system protection",
  spctl: "Gatekeeper",
  tccutil: "privacy permissions",
  dscl: "user accounts",
  dseditgroup: "user accounts",
  sysadminctl: "user accounts",
  diskutil: "disks",
  hdiutil: "disk images",
  kextload: "kernel extensions",
  kmutil: "kernel extensions",
  launchctl: "background services",
  softwareupdate: "system updates",
  installer: "installing a package",
  pkgutil: "installed packages",
  mdutil: "Spotlight settings",
  tmutil: "Time Machine",
  chsh: "the login shell",
  passwd: "the password",
  at: "scheduling a job",
  batch: "scheduling a job",
  mail: "sending mail",
  mailx: "sending mail",
  sendmail: "sending mail",
  msmtp: "sending mail",
  mutt: "mail",
  ssh: "another machine (ssh)",
  scp: "copying to another machine",
  sftp: "another machine (sftp)",
  ftp: "another machine (ftp)",
  telnet: "another machine",
  nc: "a network connection",
  ncat: "a network connection",
  socat: "a network connection",
  stripe: "payments (Stripe)",
  pbpaste: "reading the clipboard",
  screencapture: "a picture of the person's screen",
  port: "installing (MacPorts)",
  mas: "installing from the App Store",
  pipx: "installing Python tools",
  gem: "Ruby gems",
  rustup: "the Rust toolchain",
  nvm: "Node versions",
  fnm: "Node versions",
  volta: "Node versions",
  asdf: "tool versions",
  mise: "tool versions",
  pyenv: "Python versions",
  conda: "conda packages",
  corepack: "package managers",
  vercel: "a deploy (Vercel)",
  netlify: "a deploy (Netlify)",
  fly: "a deploy (Fly)",
  flyctl: "a deploy (Fly)",
  heroku: "a deploy (Heroku)",
  railway: "a deploy (Railway)",
  render: "a deploy (Render)",
  amplify: "a deploy (Amplify)",
  eb: "a deploy (Elastic Beanstalk)",
  aws: "the AWS account",
  gcloud: "the Google Cloud account",
  az: "the Azure account",
  doctl: "the DigitalOcean account",
  hcloud: "the Hetzner account",
  helm: "a Kubernetes cluster",
  pulumi: "cloud resources (Pulumi)",
  serverless: "a deploy (Serverless)",
  sls: "a deploy (Serverless)",
  eas: "an app build or release (EAS)",
  fastlane: "an app release (fastlane)",
  twine: "publishing a package",
  chown: "changing owners",
  chgrp: "changing owners",
  shred: "destroying files",
  srm: "destroying files",
};

/** Ask every time (except in full access): they run code or reach far. */
const ASK_PROGRAMS: Record<string, string> = {
  curl: "a network request",
  wget: "a download",
  kill: "stopping a process",
  pkill: "stopping processes",
  killall: "stopping processes",
  env: "the environment (it holds secrets)",
  printenv: "the environment (it holds secrets)",
  mdfind: "searching the whole computer",
  pbcopy: "the clipboard",
  source: "running a script in the shell",
  ".": "running a script in the shell",
  alias: "defining a command",
  unalias: "a command alias",
  function: "defining a command",
  trap: "a shell trap",
  hash: "the command table",
  enable: "shell builtins",
  watch: "running something repeatedly",
  parallel: "running commands",
  expect: "scripted input",
  script: "recording a session",
  screen: "a terminal session",
  tmux: "a terminal session",
  nohup: "a background process",
  disown: "a background process",
  crontab: "scheduled jobs",
  defaults: "app settings",
  xattr: "file attributes",
  codesign: "code signing",
  awk: "awk",
  gawk: "awk",
  kubectl: "a Kubernetes cluster",
  terraform: "cloud resources (Terraform)",
  tofu: "cloud resources (OpenTofu)",
  ngrok: "exposing a port to the internet",
  cloudflared: "a Cloudflare tunnel",
  pushd: "the folder stack",
  popd: "the folder stack",
};

/** Typecheck / lint tools: free, unless a flag makes them rewrite files. */
const CHECKERS: Record<string, ReadonlyArray<string>> = {
  tsc: [],
  "vue-tsc": [],
  eslint: ["--fix", "--fix-dry-run"],
  oxlint: ["--fix", "--fix-suggestions", "--fix-dangerously"],
  biome: ["--write", "--apply", "--apply-unsafe", "--fix", "--unsafe"],
  prettier: ["--write", "-w"],
  oxfmt: [],
  dprint: [],
  stylelint: ["--fix"],
  ruff: ["--fix", "--unsafe-fixes"],
  mypy: [],
  pyright: [],
  basedpyright: [],
  flake8: [],
  pylint: [],
  black: [],
  isort: [],
  swiftlint: ["--fix", "--autocorrect"],
  swiftformat: [],
  "golangci-lint": ["--fix"],
  gofmt: ["-w"],
  ktlint: ["-F", "--format"],
  rubocop: ["-a", "-A", "--autocorrect", "--autocorrect-all"],
  knip: ["--fix"],
  markdownlint: ["--fix"],
  "markdownlint-cli2": ["--fix"],
  clippy: ["--fix"],
};
/** Formatters that write unless told to only check. */
const WRITE_UNLESS_CHECK: Record<string, ReadonlyArray<string>> = {
  oxfmt: ["--check", "--list-different"],
  dprint: ["check"],
  black: ["--check", "--diff"],
  isort: ["--check", "--check-only", "--diff"],
  swiftformat: ["--lint", "--dryrun"],
  ruff: [],
};

const TEST_RUNNERS = new Set([
  "vitest",
  "jest",
  "mocha",
  "ava",
  "pytest",
  "py.test",
  "playwright",
  "cypress",
  "karma",
  "tap",
  "uvu",
]);
/** Test-runner flags that take a value (the value is no filter). */
const TEST_VALUE_FLAGS = [
  "--reporter",
  "--config",
  "-c",
  "--root",
  "-r",
  "--pool",
  "--shard",
  "--environment",
  "--outputFile",
  "--maxWorkers",
  "--minWorkers",
  "--testTimeout",
  "--mode",
  "--workspace",
  "--rootDir",
  "--browser",
  "--retry",
  "--coverage.provider",
  "-p",
  "-n",
  "--maxfail",
  "--tb",
  "--timeout",
];
const TEST_FILTER_FLAGS = [
  "-t",
  "--testNamePattern",
  "--testPathPattern",
  "-k",
  "--grep",
  "-g",
  "--project",
  "--filter",
  "-F",
  "--dir",
  "--changed",
  "--related",
  "--findRelatedTests",
  "--onlyChanged",
  "--spec",
  "--selectProjects",
  "--testFile",
];

const SCRIPT_CHECK =
  /^(typecheck|type-check|types|check-types|tsc|lint|eslint|oxlint|check|knip|depcheck|format:check|fmt:check|prettier:check|lint:(?!fix)[\w:-]+|typecheck:[\w:-]+|check:[\w:-]+)$/;
const SCRIPT_TEST = /^(test|tests|spec|e2e|vitest|jest|test:[\w:-]+|test-[\w:-]+|e2e:[\w:-]+)$/;
const SCRIPT_CHAT =
  /^(build|build:[\w:-]+|compile|bundle|dev|dev:[\w:-]+|start|start:[\w:-]+|serve|preview|watch|storybook|fmt|format|lint:fix|fix|generate|codegen|gen|prepare|clean|ios|android|web)$/;

// ── Helpers ────────────────────────────────────────────────────────────

const lower = (value: string) => value.toLowerCase();
const hasFlag = (args: ReadonlyArray<Word>, ...flags: ReadonlyArray<string>) =>
  args.some((word) =>
    flags.some(
      (flag) =>
        word.text === flag ||
        (flag.startsWith("--") && word.text.startsWith(`${flag}=`)) ||
        // Bundled short flags: `-rf` holds `-r` and `-f`.
        (flag.length === 2 &&
          flag.startsWith("-") &&
          /^-[A-Za-z]+$/.test(word.text) &&
          word.text.includes(flag[1]!)),
    ),
  );
const positional = (
  args: ReadonlyArray<Word>,
  valueFlags: ReadonlyArray<string> = [],
): Array<Word> => {
  const out: Array<Word> = [];
  let afterDashes = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (!afterDashes && word.text === "--") {
      afterDashes = true;
      continue;
    }
    if (!afterDashes && word.text.startsWith("-") && word.text.length > 1) {
      if (valueFlags.includes(word.text)) index += 1;
      continue;
    }
    out.push(word);
  }
  return out;
};

const TRUSTED_BIN_DIRS = [
  "/bin/",
  "/usr/bin/",
  "/sbin/",
  "/usr/sbin/",
  "/usr/local/bin/",
  "/opt/homebrew/bin/",
  "/opt/homebrew/sbin/",
  "/usr/libexec/",
];

/** `Google Chrome` from `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. */
function programName(word: Word): { name: string } | { script: string } {
  const text = word.text;
  if (!text.includes("/")) return { name: text };
  const base = text.slice(text.lastIndexOf("/") + 1);
  if (
    TRUSTED_BIN_DIRS.some((dir) => text.startsWith(dir) && !text.slice(dir.length).includes("/"))
  ) {
    return { name: base };
  }
  if (/(^|\/)node_modules\/\.bin\/[^/]+$/.test(text)) return { name: base };
  if (/^\/Applications\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.test(text)) return { name: base };
  return { script: text };
}

// ── The judge ──────────────────────────────────────────────────────────

const MAX_DEPTH = 4;

interface State {
  /** The folder the next command runs in; null: it can't be told. */
  cwd: string | null;
}

export function commandTier(command: string, ctx: TierContext, depth = 0): TierResult {
  if (depth > MAX_DEPTH) return r("ask", "commands nested too deep to check");
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(command)) {
    return r("ask", "control characters in the command");
  }
  const parsed = parseShell(command, ctx.home);
  let result: TierResult = FREE;
  if (parsed.broken) result = higher(result, r("ask", "a command line that doesn't parse"));
  if (parsed.parens) result = higher(result, r("ask", "a subshell or ( ) in the command"));
  if (parsed.hiddenCode) {
    result = higher(result, r("ask", "a heredoc that runs $( ) or backticks"));
  }
  for (const inner of parsed.substitutions) {
    result = higher(result, commandTier(inner, ctx, depth + 1));
  }
  const state: State = { cwd: ctx.cwd };
  for (const segment of parsed.segments) {
    result = higher(result, segmentTier(segment, state, ctx, depth));
  }
  if (parsed.segments.length === 0 && parsed.substitutions.length === 0) {
    return higher(result, r("free", "nothing to run"));
  }
  return result;
}

/** The tier of one path a command touches. */
function pathTier(
  word: Word,
  op: PathOp,
  state: State,
  ctx: TierContext,
  options: { readonly recursive?: boolean } = {},
): TierResult {
  if (word.dynamic || word.brace) {
    return op === "read"
      ? r("ask", "a path known only when it runs")
      : r("always", "changing a path known only when it runs");
  }
  const text = word.text;
  const cwd = state.cwd;
  if (cwd === null && !text.startsWith("/")) {
    return op === "read"
      ? r("ask", "a path in a folder that can't be told")
      : r("always", "changing a path in a folder that can't be told");
  }
  let raw: string | null;
  let globbed = false;
  if (word.glob) {
    const at = text.search(/[*?[]/);
    const lastSlash = text.lastIndexOf("/", at);
    const prefix = lastSlash < 0 ? "." : text.slice(0, lastSlash) || "/";
    const component = text.slice(lastSlash + 1);
    raw = absoluteRaw(prefix, cwd ?? "/", ctx.home, false);
    globbed = true;
    // `.*` reaches `.env` and other dotfiles.
    if (op === "read" && component.startsWith(".")) {
      return r("always", "reading hidden files by a pattern");
    }
  } else {
    raw = absoluteRaw(text, cwd ?? "/", ctx.home, false);
  }
  if (raw === null) return pathTier({ ...word, dynamic: true }, op, state, ctx);
  const real = ctx.facts.real(raw);
  if (real === null) return pathTier({ ...word, dynamic: true }, op, state, ctx);
  if (globbed || options.recursive) {
    const inside = sensitiveUnder(real, ctx);
    if (inside !== null && op === "read") return r("always", `reading what is in ${inside}`);
    if (inside !== null) return r("always", `changing what is in ${inside}`);
    if (globbed && op === "delete" && isRootFolder(real, ctx)) {
      return r("always", `deleting everything in ${displayPath(real, ctx.home)}`);
    }
    if (globbed) {
      const judged = judgePath(`${normalizePosix(real)}/x`, op, ctx);
      return r(judged.tier, judged.reason);
    }
  }
  const judged = judgePath(real, op, ctx);
  return r(judged.tier, judged.reason);
}

const pathsTier = (
  words: ReadonlyArray<Word>,
  op: PathOp,
  state: State,
  ctx: TierContext,
  options: { readonly recursive?: boolean } = {},
): TierResult =>
  words.reduce<TierResult>(
    (acc, word) => higher(acc, pathTier(word, op, state, ctx, options)),
    FREE,
  );

/** The folder a command runs in: outside the allowed folders, it can't be free. */
function cwdTier(state: State, ctx: TierContext): TierResult {
  if (state.cwd === null) return r("ask", "a command in a folder that can't be told");
  const real = ctx.facts.real(state.cwd);
  if (real === null) return r("ask", "a command in a folder that couldn't be checked");
  const judged = judgePath(real, "read", ctx);
  if (judged.tier === "free") return FREE;
  return r("ask", `a command in ${displayPath(real, ctx.home)}, outside allowed folders`);
}

/** Matches one of the person's allowed command starts. */
function allowedByPerson(argv: ReadonlyArray<string>, ctx: TierContext): string | null {
  for (const entry of ctx.allowedCommands) {
    const words = entry.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    if (words.every((word, index) => argv[index] === word)) return entry.trim();
  }
  return null;
}

const DANGEROUS_ASSIGNMENT =
  /^(PATH|HOME|SHELL|IFS|ENV|BASH_ENV|ZDOTDIR|PROMPT_COMMAND|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|LD_\w+|DYLD_\w+|GIT_\w+|SSH_\w+|EDITOR|VISUAL|PAGER|BROWSER|npm_config_\w+|NPM_CONFIG_\w+)$/;

const KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "!",
  "{",
  "}",
  "time",
]);

function segmentTier(segment: Segment, state: State, ctx: TierContext, depth: number): TierResult {
  let result: TierResult = FREE;
  for (const redirect of segment.redirects) {
    result = higher(result, redirectTier(redirect.op, redirect.target, state, ctx));
  }
  let words = [...segment.words];
  while (words.length > 0 && KEYWORDS.has(words[0]!.text) && !words[0]!.quoted) words.shift();
  if (words.length === 0) return result;
  const first = words[0]!;
  if (!first.quoted && (first.text === "for" || first.text === "select")) {
    // `for x in a b c`: the list is data; its use (`$x`) is dynamic later.
    return result;
  }
  if (!first.quoted && first.text === "case") return higher(result, r("ask", "a case statement"));
  if (
    !first.quoted &&
    (first.text === "export" ||
      first.text === "local" ||
      first.text === "declare" ||
      first.text === "readonly" ||
      first.text === "typeset")
  ) {
    for (const word of words.slice(1)) {
      const name = assignmentName(word) ?? word.text;
      if (DANGEROUS_ASSIGNMENT.test(name)) result = higher(result, r("ask", `changing ${name}`));
    }
    return result;
  }
  while (words.length > 0) {
    const name = assignmentName(words[0]!);
    if (name === null) break;
    if (DANGEROUS_ASSIGNMENT.test(name)) result = higher(result, r("ask", `changing ${name}`));
    words.shift();
  }
  if (words.length === 0) return result;
  return higher(result, programTier(words, segment.piped, state, ctx, depth));
}

function redirectTier(op: string, target: Word, state: State, ctx: TierContext): TierResult {
  if (op === "<<" || op === "<<-" || op === "<<<") return FREE;
  if ((op === ">&" || op === "<&") && /^(\d+|-)$/.test(target.text) && !target.dynamic) return FREE;
  if (op === "<") return pathTier(target, "read", state, ctx);
  return pathTier(target, "write", state, ctx);
}

/** argv[0] and on, after assignments. */
function programTier(
  words: ReadonlyArray<Word>,
  piped: boolean,
  state: State,
  ctx: TierContext,
  depth: number,
): TierResult {
  const head = words[0]!;
  if (head.dynamic || head.glob || head.brace) {
    return r("ask", "a command known only when it runs");
  }
  if (head.text.startsWith("=")) return r("ask", "a zsh =command");
  const named = programName(head);
  if ("script" in named) {
    const allowed = allowedByPerson(
      words.map((word) => word.text),
      ctx,
    );
    if (allowed !== null)
      return higher(r("chat", `an allowed command (${allowed})`), cwdTier(state, ctx));
    return r("ask", `running ${named.script}`);
  }
  const name = named.name;
  const key = lower(name);
  const args = words.slice(1);
  const argv = [name, ...args.map((word) => word.text)];

  // Wrappers: judge what they run.
  const wrapped = unwrap(key, args);
  if (wrapped !== null) {
    if (wrapped.kind === "always") {
      const inner =
        wrapped.rest.length > 0 ? programTier(wrapped.rest, piped, state, ctx, depth) : FREE;
      return higher(r("always", wrapped.reason), inner);
    }
    if (wrapped.kind === "ask") return r("ask", wrapped.reason);
    if (wrapped.rest.length === 0) return FREE;
    return programTier(wrapped.rest, piped, state, ctx, depth);
  }

  if (CONTAINER_PROGRAMS.has(key) || key.startsWith("qemu-system")) {
    return r("blocked", BLOCKED_CONTAINERS);
  }
  if (key === "supabase" && args.some((word) => word.text === "start")) {
    return r("blocked", BLOCKED_CONTAINERS);
  }
  if (key === "hyperfine") return r("blocked", BLOCKED_FULL_RUN);

  if (key === "cd") {
    const target = positional(args)[0];
    if (target === undefined) {
      state.cwd = ctx.home;
      return FREE;
    }
    if (target.dynamic || target.brace || target.glob || target.text === "-") {
      state.cwd = null;
      return FREE;
    }
    state.cwd =
      state.cwd === null && !target.text.startsWith("/")
        ? null
        : absoluteRaw(target.text, state.cwd ?? "/", ctx.home, false);
    return FREE;
  }

  if (SHELLS.has(key)) return shellTier(args, piped, state, ctx, depth);
  if (key === "eval") {
    return higher(
      r("ask", "eval"),
      commandTier(
        args.map((word) => word.text).join(" "),
        { ...ctx, cwd: state.cwd ?? ctx.cwd },
        depth + 1,
      ),
    );
  }
  if (key === "exec" && args.length > 0) return programTier(args, piped, state, ctx, depth);
  if (key === "xargs") return xargsTier(args, state, ctx, depth);

  if (key in ALWAYS_PROGRAMS) return r("always", ALWAYS_PROGRAMS[key]!);
  if (INTERPRETERS.has(key)) return interpreterTier(key, args, piped, state, ctx, depth);
  if (BROWSER_PROGRAMS.has(key)) return browserTier(args, state, ctx);

  const person = allowedByPerson(argv, ctx);

  const specific = specificTier(key, args, piped, state, ctx, depth);
  if (specific !== null) {
    if (person !== null && specific.tier === "ask") {
      return higher(r("chat", `an allowed command (${person})`), cwdTier(state, ctx));
    }
    return specific;
  }
  if (person !== null)
    return higher(r("chat", `an allowed command (${person})`), cwdTier(state, ctx));
  if (key in ASK_PROGRAMS) return r("ask", ASK_PROGRAMS[key]!);
  return r("ask", `${name}, not a known command`);
}

type Unwrapped =
  | { readonly kind: "run"; readonly rest: ReadonlyArray<Word> }
  | { readonly kind: "always"; readonly reason: string; readonly rest: ReadonlyArray<Word> }
  | { readonly kind: "ask"; readonly reason: string };

/** Skip leading flags; `withValue` flags take the next word. */
function skipFlags(
  args: ReadonlyArray<Word>,
  withValue: ReadonlyArray<string>,
  stopAtFirst = true,
) {
  let index = 0;
  while (index < args.length) {
    const text = args[index]!.text;
    if (text === "--") return args.slice(index + 1);
    if (!text.startsWith("-") || text === "-") break;
    index += withValue.includes(text) ? 2 : 1;
    if (!stopAtFirst) continue;
  }
  return args.slice(index);
}

function unwrap(key: string, args: ReadonlyArray<Word>): Unwrapped | null {
  switch (key) {
    case "sudo":
    case "doas":
      return {
        kind: "always",
        reason: key,
        rest: skipFlags(args, ["-u", "-g", "-C", "-D", "-h", "-p", "-U", "-r", "-t"]),
      };
    case "command":
    case "builtin":
    case "noglob":
    case "nocorrect":
      return { kind: "run", rest: skipFlags(args, []) };
    case "time":
      return { kind: "run", rest: skipFlags(args, ["-f", "-o"]) };
    case "nice":
      return { kind: "run", rest: skipFlags(args, ["-n"]) };
    case "caffeinate":
      return { kind: "run", rest: skipFlags(args, ["-t", "-w"]) };
    case "stdbuf":
      return { kind: "run", rest: skipFlags(args, []) };
    case "timeout":
    case "gtimeout": {
      const rest = skipFlags(args, ["-s", "-k", "--signal", "--kill-after"]);
      return { kind: "run", rest: rest.slice(1) };
    }
    case "env": {
      let index = 0;
      while (index < args.length) {
        const text = args[index]!.text;
        if (text === "-i" || text === "-" || text === "--ignore-environment") {
          index += 1;
          continue;
        }
        if (text === "-u" || text === "--unset") {
          index += 2;
          continue;
        }
        if (text.startsWith("-")) return { kind: "ask", reason: `env ${text}` };
        const name = assignmentName(args[index]!);
        if (name === null) break;
        if (DANGEROUS_ASSIGNMENT.test(name)) return { kind: "ask", reason: `changing ${name}` };
        index += 1;
      }
      const rest = args.slice(index);
      // Bare `env` prints the environment: secrets.
      if (rest.length === 0)
        return { kind: "ask", reason: "printing the environment (it holds secrets)" };
      return { kind: "run", rest };
    }
    case "npx":
    case "bunx":
    case "pnpx": {
      const rest = skipFlags(args, ["-p", "--package", "-c", "--call"]);
      if (args.some((word) => word.text === "-c" || word.text === "--call")) {
        return { kind: "ask", reason: `${key} -c` };
      }
      return { kind: "run", rest: stripVersion(rest) };
    }
    case "arch": {
      const rest = skipFlags(args, []);
      return { kind: "run", rest };
    }
    default:
      return null;
  }
}

/** `eslint@9` → `eslint`. */
function stripVersion(rest: ReadonlyArray<Word>): ReadonlyArray<Word> {
  if (rest.length === 0) return rest;
  const [head, ...tail] = rest;
  const text = head!.text.replace(/^(@?[^@]+)@.*$/, "$1");
  const base = text.includes("/") && !text.startsWith("@") ? text : text.replace(/^@[^/]+\//, "");
  return [{ ...head!, text: base }, ...tail];
}

function shellTier(
  args: ReadonlyArray<Word>,
  piped: boolean,
  state: State,
  ctx: TierContext,
  depth: number,
): TierResult {
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]!.text;
    if (text.startsWith("-") && !text.startsWith("--") && text.slice(1).includes("c")) {
      const script = args[index + 1];
      if (script === undefined) return r("ask", "a shell without its script");
      if (script.dynamic) return r("ask", "a shell script known only when it runs");
      return commandTier(script.text, { ...ctx, cwd: state.cwd ?? ctx.cwd }, depth + 1);
    }
    if (!text.startsWith("-")) {
      return r("ask", `running the script ${text}`);
    }
  }
  return piped ? r("always", "piping into a shell") : r("ask", "a shell");
}

function xargsTier(
  args: ReadonlyArray<Word>,
  state: State,
  ctx: TierContext,
  depth: number,
): TierResult {
  const rest = skipFlags(args, [
    "-n",
    "-L",
    "-P",
    "-s",
    "-d",
    "-E",
    "-I",
    "-J",
    "-R",
    "-S",
    "-a",
    "--max-args",
    "--max-procs",
    "--delimiter",
    "--replace",
  ]);
  if (rest.length === 0) return r("ask", "xargs");
  const inner = programTier(rest, false, state, ctx, depth + 1);
  // Its arguments come from the input: a change to unknown paths.
  const named = programName(rest[0]!);
  const name = "name" in named ? lower(named.name) : "";
  if (
    [
      "rm",
      "rmdir",
      "unlink",
      "mv",
      "cp",
      "chmod",
      "chown",
      "dd",
      "truncate",
      "tee",
      "ln",
      "shred",
      "srm",
    ].includes(name)
  ) {
    return higher(inner, r("always", `${name} on paths from the input`));
  }
  return higher(inner, r("ask", "xargs runs commands on its input"));
}

function interpreterTier(
  key: string,
  args: ReadonlyArray<Word>,
  piped: boolean,
  state: State,
  ctx: TierContext,
  _depth: number,
): TierResult {
  if (key === "osascript" || key === "jxa") return r("always", ALWAYS_PROGRAMS.osascript!);
  if (args.length === 1 && /^(-v|--version|-V|version)$/.test(args[0]!.text)) return FREE;
  if ((key === "python" || key === "python3") && args[0]?.text === "-m" && args[1] !== undefined) {
    const module = args[1].text;
    if (module === "pip") return pipTier(args.slice(2));
    if (TEST_RUNNERS.has(module)) return testRunnerTier(module, args.slice(2), state, ctx);
    if (module in CHECKERS) return checkerTier(module, args.slice(2), state, ctx);
    if (module === "venv")
      return higher(
        r("chat", "making a virtualenv"),
        pathsTier(positional(args.slice(2)), "write", state, ctx),
      );
    return r("ask", `python -m ${module}`);
  }
  if (key === "deno") {
    const sub = args[0]?.text;
    if (sub === "check" || sub === "lint" || (sub === "fmt" && hasFlag(args, "--check")))
      return higher(FREE, cwdTier(state, ctx));
    if (sub === "test") return testRunnerTier("deno", args.slice(1), state, ctx);
    if (sub === "install" || sub === "upgrade" || sub === "deploy" || sub === "publish")
      return r("always", `deno ${sub}`);
    if (sub === "task" && args[1] !== undefined)
      return scriptTier("deno", args[1].text, args.slice(2), state, ctx);
  }
  if (piped && positional(args).length === 0) return r("always", `piping code into ${key}`);
  return r("ask", `running code with ${key}`);
}

function browserTier(args: ReadonlyArray<Word>, state: State, ctx: TierContext): TierResult {
  const profile = profileArg(args);
  if (profile === null) return r("always", "the person's own browser (their logins)");
  return agentProfileTier(profile, state, ctx);
}

/** `--user-data-dir=X`, `--user-data-dir X`, `-profile X`. */
function profileArg(args: ReadonlyArray<Word>): Word | null {
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index]!;
    if (word.text.startsWith("--user-data-dir=")) {
      return { ...word, text: word.text.slice("--user-data-dir=".length) };
    }
    if (
      (word.text === "--user-data-dir" || word.text === "-profile" || word.text === "--profile") &&
      args[index + 1]
    ) {
      return args[index + 1]!;
    }
  }
  return null;
}

function agentProfileTier(profile: Word, state: State, ctx: TierContext): TierResult {
  if (profile.dynamic || profile.brace || profile.glob)
    return r("always", "a browser profile known only when it runs");
  const raw = absoluteRaw(profile.text, state.cwd ?? "/", ctx.home, false);
  const real = raw === null ? null : ctx.facts.real(raw);
  const agentRaw = expandHome(AGENT_BROWSER_PROFILE, ctx.home)!;
  const agentReal = ctx.facts.real(agentRaw) ?? agentRaw;
  if (
    real !== null &&
    isInside(normalizePosix(real), normalizePosix(agentReal), ctx.caseInsensitive)
  ) {
    return r("free", "the agents' own browser profile");
  }
  return r("always", "a browser profile other than the agents' own");
}

function openTier(args: ReadonlyArray<Word>, state: State, ctx: TierContext): TierResult {
  let app: string | null = null;
  const passed: Array<Word> = [];
  const targets: Array<Word> = [];
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]!.text;
    if (text === "--args") {
      passed.push(...args.slice(index + 1));
      break;
    }
    if (text === "-a" || text === "-b" || /^-[A-Za-z]*[ab]$/.test(text)) {
      app = args[index + 1]?.text ?? "";
      if (args[index + 1]?.dynamic) return r("ask", "an app known only when it runs");
      index += 1;
      continue;
    }
    if (text.startsWith("-")) continue;
    targets.push(args[index]!);
  }
  const appName = app === null ? null : app.replace(/^.*\//, "");
  if (appName !== null) {
    if (CONTAINER_APPS.test(appName)) return r("blocked", BLOCKED_CONTAINERS);
    if (/^simulator(\.app)?$/i.test(appName) || appName === "com.apple.iphonesimulator") {
      return r("free", "the iOS Simulator");
    }
    if (
      BROWSER_APPS.test(appName) ||
      /^com\.(google\.chrome|brave|microsoft\.edgemac|apple\.safari)/i.test(appName) ||
      appName === "org.mozilla.firefox"
    ) {
      const profile = profileArg(passed);
      if (profile === null) return r("always", "the person's own browser (their logins)");
      return agentProfileTier(profile, state, ctx);
    }
    if (PERSONAL_APPS.test(appName)) return r("always", `opening ${appName}`);
    return r("ask", `opening ${appName}`);
  }
  for (const target of targets) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target.text)) {
      return r("always", "opening a link in the person's own browser or apps");
    }
  }
  // A file opens in its default app, a page in the person's own browser.
  return r("always", "opening something in the person's own apps");
}

function pipTier(args: ReadonlyArray<Word>): TierResult {
  const sub = args.find((word) => !word.text.startsWith("-"))?.text;
  if (
    sub === undefined ||
    ["list", "show", "freeze", "check", "--version", "help", "index", "inspect"].includes(sub)
  )
    return FREE;
  if (["install", "uninstall", "download", "wheel"].includes(sub)) return r("always", `pip ${sub}`);
  return r("ask", `pip ${sub}`);
}

/** A test runner: one package or file is free, the whole repository is not. */
function testRunnerTier(
  runner: string,
  args: ReadonlyArray<Word>,
  state: State,
  ctx: TierContext,
): TierResult {
  if (args.some((word) => /bench/.test(word.text))) return r("blocked", BLOCKED_FULL_RUN);
  const rest = args.filter(
    (word) => !["run", "test", "--run", "--watch=false", "--no-watch", "--ci"].includes(word.text),
  );
  const targets = positional(rest, TEST_VALUE_FLAGS);
  const filtered = targets.length > 0 || hasFlag(rest, ...TEST_FILTER_FLAGS);
  const reads = pathsTier(targets, "read", state, ctx);
  const where = cwdTier(state, ctx);
  if (filtered) return higher(higher(r("free", `one part of the tests (${runner})`), reads), where);
  return higher(wholeSuite(state, ctx, runner), where);
}

/** No filter: free in a single package, blocked at a monorepo's root. */
function wholeSuite(state: State, ctx: TierContext, what: string): TierResult {
  if (state.cwd === null) return r("ask", `${what} in a folder that can't be told`);
  const monorepo = ctx.facts.monorepo(state.cwd);
  if (monorepo === true) return r("blocked", BLOCKED_FULL_RUN);
  if (monorepo === null)
    return r("ask", `${what}: couldn't tell one package from a whole repository`);
  return r("free", `the tests of one package (${what})`);
}

function checkerTier(
  key: string,
  args: ReadonlyArray<Word>,
  state: State,
  ctx: TierContext,
): TierResult {
  const writeFlags = CHECKERS[key] ?? [];
  const checkOnly = WRITE_UNLESS_CHECK[key];
  let writes = hasFlag(args, ...writeFlags);
  if (
    checkOnly !== undefined &&
    checkOnly.length > 0 &&
    !args.some((word) => checkOnly.includes(word.text))
  )
    writes = true;
  if (key === "ruff" && args[0]?.text === "format" && !hasFlag(args, "--check", "--diff"))
    writes = true;
  if (key === "tsc" || key === "vue-tsc") {
    writes =
      !hasFlag(args, "--noEmit", "--emitDeclarationOnly=false") &&
      !args.some(
        (word) =>
          word.text === "--noEmit" ||
          word.text === "--version" ||
          word.text === "-v" ||
          word.text === "--help",
      );
    if (hasFlag(args, "--noEmit")) writes = false;
  }
  if (key === "gofmt" && !hasFlag(args, "-w")) writes = false;
  const targets = positional(
    args.filter((word) => !["check", "format", "lint", "run", "ci"].includes(word.text)),
  );
  const where = cwdTier(state, ctx);
  if (writes) {
    return higher(
      higher(r("chat", `${key} rewriting files`), pathsTier(targets, "write", state, ctx)),
      where,
    );
  }
  return higher(
    higher(r("free", `a check (${key})`), pathsTier(targets, "read", state, ctx)),
    where,
  );
}

/** `bun run <script>`, `npm run <script>`: its name says what it does. */
function scriptTier(
  manager: string,
  script: string,
  rest: ReadonlyArray<Word>,
  state: State,
  ctx: TierContext,
  scope: "one" | "all" | "unknown" = "unknown",
): TierResult {
  const where = cwdTier(state, ctx);
  if (/bench/i.test(script)) return r("blocked", BLOCKED_FULL_RUN);
  if (SCRIPT_TEST.test(script)) {
    if (scope === "all") return r("blocked", BLOCKED_FULL_RUN);
    const filtered =
      scope === "one" ||
      positional(rest, TEST_VALUE_FLAGS).length > 0 ||
      hasFlag(rest, ...TEST_FILTER_FLAGS);
    if (filtered) return higher(r("free", `one part of the tests (${manager} ${script})`), where);
    return higher(wholeSuite(state, ctx, `${manager} ${script}`), where);
  }
  if (SCRIPT_CHECK.test(script)) {
    if (hasFlag(rest, "--fix", "--write"))
      return higher(r("chat", `${manager} ${script} --fix`), where);
    return higher(r("free", `a check (${manager} ${script})`), where);
  }
  if (SCRIPT_CHAT.test(script)) return higher(r("chat", `${manager} ${script}`), where);
  return r("ask", `the project script “${script}”`);
}

const GLOBAL_FLAGS = ["-g", "--global", "--location=global"];

/** bun / npm / pnpm / yarn. */
function packageManagerTier(
  key: string,
  args: ReadonlyArray<Word>,
  state: State,
  ctx: TierContext,
): TierResult {
  // Workspace selection may come before the command: `pnpm -F web test`.
  let scope: "one" | "all" | "unknown" = "unknown";
  const rest: Array<Word> = [];
  for (let index = 0; index < args.length; index += 1) {
    const text = args[index]!.text;
    const filterValue = (value: string | undefined) => {
      if (value === undefined) return;
      scope = /^(\*|\.\/\*|\*\*|\.\.\.|\{\*\})$/.test(value)
        ? "all"
        : scope === "all"
          ? "all"
          : "one";
    };
    if (text === "--filter" || text === "-F" || text === "-w" || text === "--workspace") {
      filterValue(args[index + 1]?.text);
      index += 1;
      continue;
    }
    if (text.startsWith("--filter=") || text.startsWith("--workspace=")) {
      filterValue(text.slice(text.indexOf("=") + 1));
      continue;
    }
    if (
      text === "-r" ||
      text === "--recursive" ||
      text === "--workspaces" ||
      text === "-ws" ||
      text === "--all"
    ) {
      scope = "all";
      continue;
    }
    if (text === "--cwd" || text === "-C" || text === "--dir" || text === "--prefix") {
      const dir = args[index + 1];
      if (dir === undefined || dir.dynamic)
        return r("ask", `${key} in a folder known only when it runs`);
      state = { cwd: absoluteRaw(dir.text, state.cwd ?? "/", ctx.home, false) };
      index += 1;
      continue;
    }
    rest.push(args[index]!);
  }
  const sub = rest[0]?.text;
  const after = rest.slice(1);
  const global = hasFlag(rest, ...GLOBAL_FLAGS) || (key === "yarn" && sub === "global");
  const where = cwdTier(state, ctx);
  if (sub === undefined)
    return key === "yarn" ? higher(r("chat", "yarn install"), where) : r("ask", key);
  if (/^(-v|--version|-h|--help|help)$/.test(sub)) return FREE;
  if (global) return r("always", `installing globally (${key} ${sub} -g)`);
  if (
    [
      "publish",
      "unpublish",
      "deprecate",
      "owner",
      "login",
      "logout",
      "adduser",
      "token",
      "access",
      "dist-tag",
      "star",
      "team",
      "org",
      "hook",
    ].includes(sub)
  ) {
    return r("always", `${key} ${sub}`);
  }
  if (sub === "link" || sub === "unlink") return r("always", `${key} ${sub} (global)`);
  if (sub === "upgrade" && key === "bun") return r("always", "upgrading bun");
  if (
    [
      "install",
      "i",
      "ci",
      "add",
      "remove",
      "rm",
      "uninstall",
      "un",
      "update",
      "up",
      "upgrade",
      "dedupe",
      "prune",
      "rebuild",
      "import",
    ].includes(sub)
  ) {
    return higher(r("chat", `${key} ${sub} in the project`), where);
  }
  if (
    [
      "ls",
      "list",
      "view",
      "info",
      "outdated",
      "why",
      "explain",
      "audit",
      "pm",
      "search",
      "show",
      "licenses",
      "root",
      "bin",
      "prefix",
    ].includes(sub)
  ) {
    return higher(FREE, where);
  }
  if (sub === "test" || sub === "t" || sub === "tst") {
    if (key === "bun") return higher(testRunnerTier("bun test", after, state, ctx), where);
    return scriptTier(key, "test", after, state, ctx, scope);
  }
  if (sub === "run" || sub === "run-script") {
    const script = after.find((word) => !word.text.startsWith("-"));
    if (script === undefined) return higher(FREE, where);
    if (script.dynamic) return r("ask", "a script known only when it runs");
    const scriptArgs = after.slice(after.indexOf(script) + 1);
    return scriptTier(key, script.text, scriptArgs, state, ctx, scope);
  }
  if (sub === "exec" || sub === "dlx" || sub === "x") {
    const inner = after.filter((word, index) => !(index === 0 && word.text === "--"));
    if (inner.length === 0) return r("ask", `${key} ${sub}`);
    return programTier(
      stripVersion(skipFlags(inner, ["-p", "--package", "-c"])),
      false,
      state,
      ctx,
      1,
    );
  }
  if (sub === "create" || sub === "init") return higher(r("chat", `${key} ${sub}`), where);
  if (sub === "build" && key === "bun") return higher(r("chat", "bun build"), where);
  if (sub === "config" || sub === "set") return r("ask", `${key} ${sub}`);
  if (sub.includes("/") || /\.(m?[jt]sx?|c[jt]s)$/.test(sub))
    return r("ask", `running ${sub} with ${key}`);
  // `bun dev`, `pnpm typecheck`, `yarn lint`: a script by its name.
  if (key !== "npm") return scriptTier(key, sub, after, state, ctx, scope);
  return r("ask", `${key} ${sub}`);
}

const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "blame",
  "describe",
  "shortlog",
  "reflog",
  "grep",
  "rev-list",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "whatchanged",
  "count-objects",
  "fsck",
  "check-ignore",
  "check-attr",
  "var",
  "help",
  "version",
  "show-ref",
  "show-branch",
  "range-diff",
  "cherry",
  "request-pull",
  "verify-commit",
  "verify-tag",
]);
const GIT_LOCAL_WRITE = new Set([
  "add",
  "commit",
  "checkout",
  "switch",
  "restore",
  "reset",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "stash",
  "branch",
  "tag",
  "mv",
  "rm",
  "clean",
  "fetch",
  "pull",
  "clone",
  "init",
  "worktree",
  "am",
  "apply",
  "notes",
  "gc",
  "prune",
  "sparse-checkout",
  "remote",
  "submodule",
  "lfs",
  "format-patch",
  "bisect",
  "restore",
  "update-index",
  "maintenance",
]);
const GIT_CONFIG_CODE =
  /^(alias\.|core\.|url\.|http\.|https\.|credential|protocol\.|gpg\.|filter\.|diff\.|merge\.|sequence\.|uploadpack\.|receive\.|remote\.[^.]+\.(receivepack|uploadpack|proxy|url|pushurl)|include|includeif|pager\.|interactive\.|sendemail\.|submodule\.|safe\.)/i;

function gitTier(args: ReadonlyArray<Word>, state: State, ctx: TierContext): TierResult {
  let result: TierResult = FREE;
  let index = 0;
  let local: State = { cwd: state.cwd };
  while (index < args.length && args[index]!.text.startsWith("-")) {
    const text = args[index]!.text;
    if (text === "-C") {
      const dir = args[index + 1];
      if (dir === undefined || dir.dynamic)
        return r("ask", "git in a folder known only when it runs");
      local = { cwd: absoluteRaw(dir.text, local.cwd ?? "/", ctx.home, false) };
      index += 2;
      continue;
    }
    if (text === "-c") {
      const setting = args[index + 1]?.text ?? "";
      result = higher(
        result,
        GIT_CONFIG_CODE.test(setting)
          ? r("always", `git -c ${setting.split("=")[0]}`)
          : r("ask", "git -c"),
      );
      index += 2;
      continue;
    }
    if (
      text.startsWith("--git-dir") ||
      text.startsWith("--work-tree") ||
      text.startsWith("--exec-path") ||
      text.startsWith("--namespace")
    ) {
      result = higher(result, r("ask", `git ${text.split("=")[0]}`));
      index += text.includes("=") ? 1 : 2;
      continue;
    }
    index += 1;
  }
  const sub = args[index]?.text;
  const rest = args.slice(index + 1);
  const where = cwdTier(local, ctx);
  if (sub === undefined || sub === "--version") return higher(result, FREE);
  if (args[index]!.dynamic) return r("ask", "a git command known only when it runs");
  if (sub === "push" || sub === "send-email" || sub === "svn" || sub === "p4")
    return higher(result, r("always", `git ${sub}`));
  if (sub === "lfs" && rest[0]?.text === "push") return r("always", "git lfs push");
  if (sub === "filter-branch" || sub === "filter-repo")
    return r("always", `git ${sub} (rewrites history)`);
  if (sub === "config") {
    const values = positional(rest);
    const reading =
      hasFlag(
        rest,
        "--get",
        "--get-all",
        "--get-regexp",
        "--list",
        "-l",
        "--show-origin",
        "--show-scope",
        "--get-urlmatch",
      ) || values.length <= 1;
    if (reading) return higher(higher(result, FREE), where);
    if (hasFlag(rest, "--global", "--system", "--file", "-f"))
      return r("always", "changing git settings outside the project");
    const keyName = values[0]?.text ?? "";
    if (GIT_CONFIG_CODE.test(keyName)) return r("always", `git config ${keyName}`);
    return higher(higher(result, r("chat", "git config in the project")), where);
  }
  if (sub === "submodule" && rest[0]?.text === "foreach") return r("ask", "git submodule foreach");
  if (sub === "bisect" && rest[0]?.text === "run") return r("ask", "git bisect run");
  if (sub === "remote") {
    const action = rest[0]?.text;
    if (action === undefined || action === "-v" || action === "show" || action === "get-url")
      return higher(higher(result, FREE), where);
  }
  if (sub === "branch" || sub === "tag" || sub === "stash" || sub === "worktree") {
    const action = rest.find((word) => !word.text.startsWith("-"));
    const listing =
      (rest.length === 0 && sub !== "stash") ||
      (action === undefined &&
        hasFlag(
          rest,
          "-l",
          "--list",
          "-a",
          "-r",
          "-v",
          "-vv",
          "--show-current",
          "--contains",
          "--merged",
        )) ||
      (sub === "stash" && (action?.text === "list" || action?.text === "show")) ||
      (sub === "worktree" && action?.text === "list");
    if (listing) return higher(higher(result, FREE), where);
  }
  if (GIT_READ.has(sub)) return higher(higher(result, FREE), where);
  if (sub === "clone") {
    const targets = positional(rest);
    const dest = targets.length >= 2 ? targets[targets.length - 1]! : null;
    const destTier = dest === null ? where : pathTier(dest, "write", local, ctx);
    return higher(higher(result, r("chat", "git clone")), destTier);
  }
  if (GIT_LOCAL_WRITE.has(sub)) return higher(higher(result, r("chat", `git ${sub}`)), where);
  // Not a git command we know: maybe one of the person's aliases.
  return r("ask", `git ${sub}`);
}

function simctlTier(args: ReadonlyArray<Word>, state: State, ctx: TierContext): TierResult {
  const sub = args[0]?.text;
  const rest = args.slice(1);
  if (sub === undefined) return FREE;
  if (
    [
      "boot",
      "shutdown",
      "list",
      "launch",
      "terminate",
      "openurl",
      "status_bar",
      "ui",
      "privacy",
      "push",
      "getenv",
      "help",
      "bootstatus",
      "appinfo",
      "listapps",
      "get_app_container",
      "keychain",
      "pbsync",
      "location",
    ].includes(sub)
  ) {
    return r("free", `the iOS Simulator (simctl ${sub})`);
  }
  if (sub === "install" || sub === "addmedia") {
    return higher(
      r("free", `the iOS Simulator (simctl ${sub})`),
      pathsTier(positional(rest).slice(1), "read", state, ctx),
    );
  }
  if (sub === "io") {
    const action = rest[1]?.text;
    if (action === "screenshot" || action === "recordVideo") {
      const file = positional(rest.slice(2))[0];
      if (file === undefined) return r("free", "a Simulator screenshot");
      const written = pathTier(file, "write", state, ctx);
      // The picture is the Simulator's, not the person's: writing it where agents write is free.
      return written.tier === "chat"
        ? r("free", "a Simulator screenshot")
        : higher(r("free", "a Simulator screenshot"), written);
    }
    return r("free", "the iOS Simulator (simctl io)");
  }
  if (
    [
      "create",
      "clone",
      "erase",
      "delete",
      "uninstall",
      "rename",
      "upgrade",
      "pair",
      "unpair",
    ].includes(sub)
  ) {
    return r("chat", `simctl ${sub}`);
  }
  return r("ask", `simctl ${sub}`);
}

function xcrunTier(
  args: ReadonlyArray<Word>,
  piped: boolean,
  state: State,
  ctx: TierContext,
  depth: number,
): TierResult {
  const rest = skipFlags(args, ["--sdk", "-sdk", "--toolchain", "-toolchain"]);
  const tool = rest[0]?.text;
  if (tool === undefined || rest[0]!.text.startsWith("-")) return FREE;
  if (tool === "simctl") return simctlTier(rest.slice(1), state, ctx);
  if (tool === "notarytool" || tool === "altool" || tool === "stapler")
    return r("always", `xcrun ${tool} (talks to Apple)`);
  if (tool === "devicectl") return r("ask", "a real device (devicectl)");
  if (tool === "xctrace") return r("ask", "xctrace");
  return programTier(rest, piped, state, ctx, depth);
}

function cargoTier(args: ReadonlyArray<Word>, state: State, ctx: TierContext): TierResult {
  const rest = skipFlags(args, ["-C", "--manifest-path", "--config", "-Z"]);
  const sub = rest[0]?.text;
  const after = rest.slice(1);
  const where = cwdTier(state, ctx);
  if (sub === undefined || /^(-V|--version|help)$/.test(sub)) return FREE;
  if (sub === "bench") return r("blocked", BLOCKED_FULL_RUN);
  if (sub === "test" || sub === "t" || sub === "nextest") {
    if (hasFlag(after, "--workspace", "--all")) return r("blocked", BLOCKED_FULL_RUN);
    if (after.some((word) => word.text === "--bench" || word.text === "--benches"))
      return r("blocked", BLOCKED_FULL_RUN);
    if (hasFlag(after, "-p", "--package") || positional(after).length > 0)
      return higher(r("free", "one crate's tests"), where);
    return higher(wholeSuite(state, ctx, "cargo test"), where);
  }
  if (
    sub === "check" ||
    sub === "c" ||
    sub === "clippy" ||
    sub === "doc" ||
    sub === "tree" ||
    sub === "metadata" ||
    sub === "search" ||
    sub === "audit" ||
    sub === "deny"
  ) {
    if (sub === "clippy" && hasFlag(after, "--fix"))
      return higher(r("chat", "cargo clippy --fix"), where);
    if (sub === "doc" && hasFlag(after, "--open"))
      return r("always", "opening docs in the person's browser");
    return higher(r("free", `cargo ${sub}`), where);
  }
  if (sub === "fmt")
    return higher(
      hasFlag(after, "--check") ? r("free", "cargo fmt --check") : r("chat", "cargo fmt"),
      where,
    );
  if (["install", "uninstall", "publish", "login", "logout", "yank", "owner"].includes(sub))
    return r("always", `cargo ${sub}`);
  if (
    [
      "build",
      "b",
      "run",
      "r",
      "add",
      "remove",
      "update",
      "fetch",
      "new",
      "init",
      "clean",
      "fix",
      "generate-lockfile",
      "vendor",
    ].includes(sub)
  ) {
    return higher(r("chat", `cargo ${sub}`), where);
  }
  return r("ask", `cargo ${sub}`);
}

function goTier(args: ReadonlyArray<Word>, state: State, ctx: TierContext): TierResult {
  const sub = args[0]?.text;
  const after = args.slice(1);
  const where = cwdTier(state, ctx);
  if (sub === undefined || sub === "version" || sub === "help") return FREE;
  if (sub === "test") {
    if (after.some((word) => word.text.startsWith("-bench"))) return r("blocked", BLOCKED_FULL_RUN);
    const packages = positional(after);
    if (
      packages.length > 0 &&
      !packages.some((word) => word.text === "./..." || word.text === "...")
    ) {
      return higher(r("free", "one Go package's tests"), where);
    }
    return higher(wholeSuite(state, ctx, "go test"), where);
  }
  if (
    sub === "vet" ||
    sub === "list" ||
    sub === "doc" ||
    (sub === "env" && !hasFlag(after, "-w", "-u"))
  )
    return higher(r("free", `go ${sub}`), where);
  if (sub === "install") return r("always", "go install");
  if (["build", "run", "generate", "get", "mod", "fmt", "work", "clean"].includes(sub))
    return higher(r("chat", `go ${sub}`), where);
  return r("ask", `go ${sub}`);
}

function swiftTier(
  args: ReadonlyArray<Word>,
  piped: boolean,
  state: State,
  ctx: TierContext,
  depth: number,
): TierResult {
  const sub = args[0]?.text;
  const where = cwdTier(state, ctx);
  if (sub === "test") return higher(r("free", "swift test"), where);
  if (sub === "build" || sub === "run" || sub === "package")
    return higher(r("chat", `swift ${sub}`), where);
  if (sub === "--version" || sub === "-version") return FREE;
  return interpreterTier("swift", args, piped, state, ctx, depth);
}

function turboTier(
  key: string,
  args: ReadonlyArray<Word>,
  state: State,
  ctx: TierContext,
): TierResult {
  const where = cwdTier(state, ctx);
  const filtered =
    hasFlag(args, "--filter", "-F") &&
    !args.some((word) => /^(--filter=)?(\*|\.\/\*|\.\.\.)$/.test(word.text));
  const tasks = positional(args)
    .map((word) => word.text)
    .filter((task) => task !== "run" && task !== "run-many" && task !== "affected");
  const taskFlag = args.findIndex(
    (word) => word.text === "-t" || word.text === "--target" || word.text === "--targets",
  );
  if (taskFlag >= 0 && args[taskFlag + 1]) tasks.push(...args[taskFlag + 1]!.text.split(","));
  const scoped = filtered || hasFlag(args, "-p", "--projects", "--scope");
  if (
    key === "nx" &&
    positional(args)[0]?.text !== "run-many" &&
    positional(args)[0]?.text !== "affected"
  ) {
    // `nx test web`, `nx run web:test`: one project.
    if (tasks.some((task) => /bench/.test(task))) return r("blocked", BLOCKED_FULL_RUN);
    if (tasks.some((task) => /test/.test(task)))
      return higher(r("free", "one project's tests"), where);
  }
  if (tasks.some((task) => /bench/.test(task))) return r("blocked", BLOCKED_FULL_RUN);
  if (tasks.some((task) => /(^|:)(test|e2e)/.test(task))) {
    return scoped
      ? higher(r("free", `one package's tests (${key})`), where)
      : r("blocked", BLOCKED_FULL_RUN);
  }
  if (tasks.length > 0 && tasks.every((task) => SCRIPT_CHECK.test(task)))
    return higher(r("free", `a check (${key})`), where);
  if (tasks.length > 0 && tasks.every((task) => SCRIPT_CHAT.test(task)))
    return higher(r("chat", `${key} ${tasks.join(" ")}`), where);
  return r("ask", `${key} ${tasks.join(" ")}`.trim());
}

function findTier(
  args: ReadonlyArray<Word>,
  state: State,
  ctx: TierContext,
  depth: number,
): TierResult {
  const roots: Array<Word> = [];
  let index = 0;
  while (index < args.length && /^-[HLPEXdsx]+$/.test(args[index]!.text)) index += 1;
  const follows = args.slice(0, index).some((word) => word.text.includes("L"));
  while (
    index < args.length &&
    !args[index]!.text.startsWith("-") &&
    args[index]!.text !== "(" &&
    args[index]!.text !== "!"
  ) {
    roots.push(args[index]!);
    index += 1;
  }
  if (roots.length === 0)
    roots.push({ text: ".", dynamic: false, glob: false, brace: false, quoted: false });
  let result = pathsTier(roots, "read", state, ctx);
  if (follows) result = higher(result, r("ask", "find following symlinks"));
  const expression = args.slice(index);
  for (let at = 0; at < expression.length; at += 1) {
    const text = expression[at]!.text;
    if (text === "-delete")
      result = higher(result, pathsTier(roots, "delete", state, ctx, { recursive: true }));
    if (text === "-fprint" || text === "-fprint0" || text === "-fprintf" || text === "-fls") {
      const file = expression[at + 1];
      if (file) result = higher(result, pathTier(file, "write", state, ctx));
    }
    if (text === "-exec" || text === "-execdir" || text === "-ok" || text === "-okdir") {
      const end = expression.findIndex(
        (word, position) => position > at && (word.text === ";" || word.text === "+"),
      );
      const inner = expression.slice(at + 1, end < 0 ? undefined : end);
      if (inner.length === 0) return higher(result, r("ask", "find -exec"));
      // `{}` stands for what find found: a path under each root.
      const placed = inner.map((word) =>
        word.text.includes("{}")
          ? { ...word, text: `${roots[0]!.text.replace(/\/+$/, "")}/x` }
          : word,
      );
      result = higher(result, programTier(placed, false, { cwd: state.cwd }, ctx, depth + 1));
      if (end < 0) break;
      at = end;
    }
  }
  return result;
}

/** Programs with their own rules; null: not one of them. */
function specificTier(
  key: string,
  args: ReadonlyArray<Word>,
  piped: boolean,
  state: State,
  ctx: TierContext,
  depth: number,
): TierResult | null {
  const where = () => cwdTier(state, ctx);
  const all = positional(args);
  switch (key) {
    case "git":
      return gitTier(args, state, ctx);
    case "gh": {
      const sub = args[0]?.text;
      const action = args[1]?.text;
      if (sub === "api") {
        const method = args.findIndex((word) => word.text === "-X" || word.text === "--method");
        const changes =
          (method >= 0 && args[method + 1]?.text.toUpperCase() !== "GET") ||
          hasFlag(args, "-f", "-F", "--field", "--raw-field", "--input");
        return changes ? r("always", "gh api changing GitHub") : r("free", "reading GitHub");
      }
      const reads = ["view", "list", "status", "diff", "checks", "watch", "search", "browse"];
      if (action === "browse" || sub === "browse")
        return r("always", "opening the person's browser");
      if (
        sub === "auth" ||
        sub === "secret" ||
        sub === "ssh-key" ||
        sub === "gpg-key" ||
        sub === "variable" ||
        sub === "extension" ||
        sub === "config"
      ) {
        return action === "status" || action === "list" ? FREE : r("always", `gh ${sub}`);
      }
      if (action !== undefined && reads.includes(action)) return r("free", "reading GitHub");
      if (sub === "pr" && action === "checkout")
        return higher(r("chat", "gh pr checkout"), where());
      if (sub === "repo" && action === "clone") return higher(r("chat", "gh repo clone"), where());
      return r("always", `gh ${[sub, action].filter(Boolean).join(" ")} (changes GitHub)`);
    }
    case "rm":
    case "rmdir":
    case "unlink": {
      const recursive = hasFlag(args, "-r", "-R", "--recursive");
      if (all.length === 0) return r("ask", `${key} without paths`);
      return pathsTier(all, "delete", state, ctx, { recursive });
    }
    case "mkdir":
    case "touch":
    case "truncate":
    case "tee":
      return higher(
        r("free", key),
        pathsTier(
          key === "truncate" ? all.filter((word) => !/^[+-]?\d/.test(word.text)) : all,
          "write",
          state,
          ctx,
        ),
      );
    case "chmod": {
      const targets = all.slice(1);
      return higher(
        r("chat", "chmod"),
        pathsTier(targets, "write", state, ctx, { recursive: hasFlag(args, "-R") }),
      );
    }
    case "cp":
    case "ln":
    case "install":
    case "ditto":
    case "rsync": {
      if (
        key === "rsync" &&
        all.some((word) => /^[^/]*:/.test(word.text) || word.text.startsWith("rsync://"))
      ) {
        return r("always", "copying to or from another machine");
      }
      if (all.length < 2) return r("ask", `${key} with one path`);
      const recursive =
        hasFlag(args, "-r", "-R", "-a", "--recursive", "--archive") ||
        key === "ditto" ||
        key === "rsync";
      const sources = all.slice(0, -1);
      const dest = all[all.length - 1]!;
      const sourceTier =
        key === "ln" ? FREE : pathsTier(sources, "read", state, ctx, { recursive });
      const deletes =
        key === "rsync" &&
        hasFlag(args, "--delete", "--delete-after", "--delete-before", "--delete-during");
      return higher(
        higher(r("chat", key), sourceTier),
        pathTier(dest, deletes ? "delete" : "write", state, ctx, { recursive: deletes }),
      );
    }
    case "mv": {
      if (all.length < 2) return r("ask", "mv with one path");
      const sources = all.slice(0, -1);
      return higher(
        higher(r("chat", "mv"), pathsTier(sources, "delete", state, ctx)),
        pathTier(all[all.length - 1]!, "write", state, ctx),
      );
    }
    case "dd": {
      let result: TierResult = r("chat", "dd");
      for (const word of args) {
        if (word.text.startsWith("of="))
          result = higher(
            result,
            pathTier({ ...word, text: word.text.slice(3) }, "write", state, ctx),
          );
        if (word.text.startsWith("if="))
          result = higher(
            result,
            pathTier({ ...word, text: word.text.slice(3) }, "read", state, ctx),
          );
      }
      return result;
    }
    case "sed":
    case "gsed": {
      const inPlace = args.some(
        (word) =>
          word.text === "-i" ||
          word.text.startsWith("-i") ||
          word.text === "--in-place" ||
          word.text.startsWith("--in-place="),
      );
      const scriptFlag = args.findIndex(
        (word) => word.text === "-e" || word.text === "--expression",
      );
      const files = scriptFlag >= 0 ? all : all.slice(1);
      const script = scriptFlag >= 0 ? (args[scriptFlag + 1]?.text ?? "") : (all[0]?.text ?? "");
      // `w file` writes, `e` runs a command.
      if (/(^|[;{}\n])\s*[0-9,$/]*\s*[weWr]\s|\/[gpiIm0-9]*w\s|(^|[;{}\n])\s*e\b/.test(script)) {
        return r("ask", "a sed script that writes files or runs commands");
      }
      if (hasFlag(args, "-f")) return r("ask", "a sed script from a file");
      const filesOnly = files.filter((word) => word.text !== script);
      if (inPlace) return higher(r("chat", "sed -i"), pathsTier(filesOnly, "write", state, ctx));
      return higher(FREE, filesOnly.length > 0 ? pathsTier(filesOnly, "read", state, ctx) : FREE);
    }
    case "grep":
    case "egrep":
    case "fgrep":
    case "zgrep": {
      const patternFlag = args.some(
        (word) => word.text === "-e" || word.text === "-f" || word.text.startsWith("--regexp"),
      );
      const files = patternFlag ? all : all.slice(1);
      const recursive = hasFlag(args, "-r", "-R", "--recursive", "--dereference-recursive");
      if (files.length === 0)
        return recursive
          ? pathTier(
              { text: ".", dynamic: false, glob: false, brace: false, quoted: false },
              "read",
              state,
              ctx,
              { recursive },
            )
          : FREE;
      return pathsTier(files, "read", state, ctx, { recursive });
    }
    case "sort": {
      const out = args.findIndex((word) => word.text === "-o" || word.text.startsWith("--output"));
      const reads = pathsTier(all, "read", state, ctx);
      if (out >= 0) {
        const file = args[out]!.text.startsWith("--output=")
          ? { ...args[out]!, text: args[out]!.text.slice(9) }
          : args[out + 1];
        return file ? higher(reads, pathTier(file, "write", state, ctx)) : reads;
      }
      return reads;
    }
    case "find":
      return findTier(args, state, ctx, depth);
    case "tar":
    case "bsdtar":
    case "zip":
    case "unzip":
    case "gzip":
    case "gunzip":
    case "bzip2":
    case "xz":
    case "7z":
    case "7zz": {
      const extractTo = args.findIndex((word) => word.text === "-C" || word.text === "-d");
      let result: TierResult = higher(r("chat", key), where());
      result = higher(result, pathsTier(all, "write", state, ctx, { recursive: true }));
      if (extractTo >= 0 && args[extractTo + 1])
        result = higher(result, pathTier(args[extractTo + 1]!, "write", state, ctx));
      return result;
    }
    case "patch":
      return higher(r("chat", "patch"), where());
    case "open":
      return openTier(args, state, ctx);
    case "defaults": {
      const sub = args[0]?.text;
      if (sub === "read" || sub === "domains" || sub === "read-type" || sub === "find") {
        return r("ask", "reading app settings");
      }
      return r("always", `changing app settings (defaults ${sub ?? ""})`.trim());
    }
    case "xcrun":
      return xcrunTier(args, piped, state, ctx, depth);
    case "simctl":
      return simctlTier(args, state, ctx);
    case "xcodebuild": {
      if (
        hasFlag(args, "-list", "-version", "-showsdks", "-showBuildSettings", "-showdestinations")
      )
        return higher(FREE, where());
      return higher(r("chat", "xcodebuild"), where());
    }
    case "xcode-select":
      return hasFlag(args, "-p", "--print-path", "-v", "--version")
        ? FREE
        : r("always", "changing the active Xcode");
    case "pod":
      if (args[0]?.text === "trunk") return r("always", "publishing a pod");
      return higher(r("chat", `pod ${args[0]?.text ?? ""}`.trim()), where());
    case "brew": {
      const sub = args.find((word) => !word.text.startsWith("-"))?.text;
      if (
        sub === undefined ||
        [
          "list",
          "ls",
          "info",
          "search",
          "config",
          "doctor",
          "outdated",
          "deps",
          "uses",
          "leaves",
          "desc",
          "--version",
          "--prefix",
          "--cellar",
          "commands",
          "help",
          "shellenv",
        ].includes(sub) ||
        hasFlag(args, "--version", "--prefix")
      ) {
        return FREE;
      }
      return r("always", `brew ${sub}`);
    }
    case "pip":
    case "pip3":
      return pipTier(args);
    case "uv": {
      const sub = args[0]?.text;
      if (sub === "pip") return pipTier(args.slice(1));
      if (sub === "tool" || sub === "self" || (sub === "python" && args[1]?.text === "install"))
        return r("always", `uv ${sub}`);
      if (sub === "publish") return r("always", "uv publish");
      if (sub === "run")
        return args.length > 1
          ? programTier(
              skipFlags(args.slice(1), ["--with", "--python", "-p", "--project", "--directory"]),
              piped,
              state,
              ctx,
              depth,
            )
          : r("ask", "uv run");
      if (
        sub === "sync" ||
        sub === "add" ||
        sub === "remove" ||
        sub === "lock" ||
        sub === "venv" ||
        sub === "init"
      )
        return higher(r("chat", `uv ${sub}`), where());
      return r("ask", `uv ${sub ?? ""}`.trim());
    }
    case "poetry": {
      const sub = args[0]?.text;
      if (sub === "publish") return r("always", "poetry publish");
      if (sub === "run") return programTier(args.slice(1), piped, state, ctx, depth);
      if (sub === "check" || sub === "show") return higher(FREE, where());
      return higher(r("chat", `poetry ${sub ?? ""}`.trim()), where());
    }
    case "bundle":
      if (args[0]?.text === "exec") return programTier(args.slice(1), piped, state, ctx, depth);
      return higher(r("chat", `bundle ${args[0]?.text ?? ""}`.trim()), where());
    case "bun":
    case "npm":
    case "pnpm":
    case "yarn":
      return packageManagerTier(key, args, state, ctx);
    case "turbo":
    case "nx":
    case "lerna":
      return turboTier(key, args, state, ctx);
    case "cargo":
      return cargoTier(args, state, ctx);
    case "go":
      return goTier(args, state, ctx);
    case "swift":
      return swiftTier(args, piped, state, ctx, depth);
    case "wrangler": {
      const sub = args[0]?.text;
      if (sub === "dev") return higher(r("chat", "wrangler dev"), where());
      if (sub === "whoami" || sub === "--version") return FREE;
      return r("always", `wrangler ${sub ?? ""} (Cloudflare)`.trim());
    }
    case "firebase": {
      const sub = args[0]?.text;
      if (sub === "emulators:start" || sub === "serve")
        return higher(r("chat", `firebase ${sub}`), where());
      return r("always", `firebase ${sub ?? ""}`.trim());
    }
    case "expo": {
      const sub = args[0]?.text;
      if (sub === "publish" || sub === "upload") return r("always", `expo ${sub}`);
      return higher(r("chat", `expo ${sub ?? ""}`.trim()), where());
    }
    case "playwright": {
      const sub = args[0]?.text;
      if (sub === "test") return testRunnerTier("playwright", args.slice(1), state, ctx);
      if (sub === "install") return higher(r("chat", "installing Playwright's browsers"), where());
      if (sub === "screenshot" || sub === "pdf") {
        // A fresh profile every time: no logins of the person's.
        const out = positional(args.slice(1))[1];
        const shot = r("free", `playwright ${sub}`);
        if (out === undefined) return shot;
        const written = pathTier(out, "write", state, ctx);
        return written.tier === "chat" ? shot : higher(shot, written);
      }
      if (sub === "open" || sub === "codegen" || sub === "cr" || sub === "ff" || sub === "wk") {
        const profile = profileArg(args);
        return profile === null
          ? r("free", "a fresh browser profile (Playwright)")
          : agentProfileTier(profile, state, ctx);
      }
      return r("ask", `playwright ${sub ?? ""}`.trim());
    }
    case "make":
    case "gmake":
    case "just":
    case "cmake":
    case "ninja":
    case "meson":
    case "gradle":
    case "mvn":
    case "vite":
    case "next":
    case "webpack":
    case "esbuild":
    case "rollup":
    case "tsup":
    case "tsdown":
      return null;
    default: {
      if (TEST_RUNNERS.has(key)) {
        if (key === "vitest" && args[0]?.text === "bench") return r("blocked", BLOCKED_FULL_RUN);
        return testRunnerTier(key, args, state, ctx);
      }
      if (key in CHECKERS) return checkerTier(key, args, state, ctx);
      if (PURE.has(key)) return FREE;
      if (key === "ls" || READERS.has(key)) {
        const targets =
          all.length > 0
            ? all
            : [{ text: ".", dynamic: false, glob: false, brace: false, quoted: false }];
        const recursive = RECURSIVE_READERS.has(key) || (key === "ls" && hasFlag(args, "-R"));
        if (key === "plutil" && hasFlag(args, "-convert", "-replace", "-insert", "-remove")) {
          return higher(
            r("chat", "plutil changing a file"),
            pathsTier(all.slice(1), "write", state, ctx),
          );
        }
        return higher(
          r("free", "reading"),
          pathsTier(
            key === "codesign" || key === "lsof" || key === "ps" ? [] : targets,
            "read",
            state,
            ctx,
            { recursive },
          ),
        );
      }
      if (key === "rg" || key === "ag" || key === "ack") {
        const files = all.slice(1);
        const targets =
          files.length > 0
            ? files
            : [{ text: ".", dynamic: false, glob: false, brace: false, quoted: false }];
        return pathsTier(targets, "read", state, ctx, { recursive: true });
      }
      if (key === "sysctl")
        return hasFlag(args, "-w") || all.some((word) => word.text.includes("="))
          ? r("always", "kernel settings")
          : FREE;
      if (key === "launchctl" || key === "crontab") return null;
      return null;
    }
  }
}
