/**
 * What an agent's Allow card says: the step in plain words, the command folded
 * under it (Misha 30.10: "Wants to delete 3 files"). A title may only be as
 * sure as the command is plain: anything it can't read whole (a chain, a pipe,
 * a redirect, a substitution, a tool it doesn't know) stays "Wants to run a
 * command" with the command open. A friendly line must never hide what runs.
 */

export type ApprovalRequestKind = "command" | "file-change" | "file-read" | "other";

export interface ApprovalDescription {
  readonly title: string;
  /** The exact command, path or text; null when there is nothing to add. */
  readonly detail: string | null;
  /** The title already says it: the detail folds. */
  readonly foldDetail: boolean;
}

const GENERIC_TITLE: Readonly<Record<ApprovalRequestKind, string>> = {
  command: "Wants to run a command",
  "file-change": "Wants to change a file",
  "file-read": "Wants to read a file",
  other: "Asks before going on",
};

/** Texts a harness sends in place of a detail: they say nothing. */
const EMPTY_DETAILS: ReadonlySet<string> = new Set(["Changed files", "edit", "write", "patch"]);

/** Claude's detail is `Bash: <command>`, Codex's and OpenCode's the command itself. */
const TOOL_PREFIX = /^(?:Bash|bash|Shell|shell|exec_command):\s+/;

/** Shell that makes a line more than one plain command. */
const NOT_PLAIN = /[|<>`\n]|\$\(|\|\||;|&(?!&)/;

const baseName = (path: string): string => {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || path;
};

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : `${count} ${many}`;

function words(command: string): ReadonlyArray<string> | null {
  const parsed: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    parsed.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return parsed.length > 0 ? parsed : null;
}

const operandsOf = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.filter((arg) => !arg.startsWith("-"));

function hostOf(target: string | undefined): string | null {
  if (!target) return null;
  const withoutScheme = target.replace(/^[a-z+]+:\/\//i, "");
  const host = withoutScheme.split(/[/?#]/)[0]?.split("@").pop()?.split(":")[0];
  return host ? host : null;
}

function deleteTitle(args: ReadonlyArray<string>): string | null {
  const targets = operandsOf(args);
  const only = targets[0];
  if (only === undefined) return null;
  if (targets.length > 1) return `Wants to delete ${targets.length} files`;
  // `rm -rf ~` must read as what it is, not as "delete ~".
  if (/^(?:~|\/|\.|\.\.|\$HOME)\/?$/.test(only)) return null;
  return `Wants to delete ${/[*?]/.test(only) ? only : baseName(only)}`;
}

function gitTitle(args: ReadonlyArray<string>): string | null {
  const [sub, ...rest] = operandsOf(args);
  switch (sub) {
    case "status":
    case "diff":
    case "log":
    case "show":
      return "Wants to look at the project's history";
    case "add":
      return "Wants to stage changes";
    case "commit":
      return "Wants to save a version of the project";
    case "push":
      return args.some((arg) => arg === "--force" || arg === "-f")
        ? "Wants to overwrite the project's remote copy"
        : "Wants to upload changes to the project's remote copy";
    case "pull":
    case "fetch":
      return "Wants to download the project's latest changes";
    case "clone":
      return `Wants to download ${baseName(rest[0] ?? "a project").replace(/\.git$/, "")}`;
    case "checkout":
    case "switch":
      return "Wants to switch to another version of the project";
    case "reset":
      return args.includes("--hard") ? "Wants to throw away local changes" : null;
    case "clean":
      return "Wants to delete files git isn't tracking";
    default:
      return null;
  }
}

const INSTALLERS: ReadonlySet<string> = new Set(["install", "i", "add", "ci"]);
const PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "pip",
  "pip3",
  "brew",
  "apt",
  "apt-get",
  "cargo",
  "gem",
]);

function packageTitle(args: ReadonlyArray<string>): string | null {
  const [sub, name] = operandsOf(args);
  if (sub === undefined) return null;
  if (INSTALLERS.has(sub)) return "Wants to install packages";
  if (sub === "uninstall" || sub === "remove" || sub === "rm") {
    return "Wants to remove packages";
  }
  if (sub === "test") return "Wants to run the tests";
  if (sub === "run" && name) return name === "test" ? "Wants to run the tests" : `Wants to run ${name}`;
  return null;
}

function curlTitle(args: ReadonlyArray<string>): string | null {
  const host = hostOf(args.find((arg) => /^[a-z+]+:\/\//i.test(arg)));
  if (!host) return null;
  const sends = args.some((arg) => /^(?:-d|-F|-T|--data.*|--form|--upload-file|-X|--request)$/.test(arg));
  return sends ? `Wants to send data to ${host}` : `Wants to download from ${host}`;
}

function plainCommandTitle(command: string): string | null {
  if (NOT_PLAIN.test(command.replace(/&&/g, ""))) return null;
  // `cd somewhere && <the step>` is one step; more than that isn't plain.
  const steps = command
    .split("&&")
    .map((step) => step.trim())
    .filter((step) => step.length > 0 && !/^cd(\s|$)/.test(step));
  const step = steps[0];
  if (steps.length !== 1 || step === undefined) return null;
  const parsed = words(step);
  if (!parsed) return null;
  const [tool, ...args] = parsed;
  // Not "plain words": it runs as the machine's administrator.
  if (tool === undefined || tool === "sudo") return null;
  const operands = operandsOf(args);
  switch (tool) {
    case "rm":
    case "unlink":
    case "rmdir":
      return deleteTitle(args);
    case "mv":
      return operands.length === 2
        ? `Wants to move ${baseName(operands[0]!)} to ${baseName(operands[1]!)}`
        : null;
    case "cp":
      return operands.length === 2
        ? `Wants to copy ${baseName(operands[0]!)} to ${baseName(operands[1]!)}`
        : null;
    case "mkdir":
      return operands.length === 1
        ? `Wants to make a folder: ${baseName(operands[0]!)}`
        : `Wants to make ${plural(operands.length, "a folder", "folders")}`;
    case "touch":
      return operands.length === 1 ? `Wants to create ${baseName(operands[0]!)}` : null;
    case "cat":
    case "head":
    case "tail":
    case "less":
      return operands.length === 1 ? `Wants to read ${baseName(operands.at(-1)!)}` : null;
    case "ls":
      return "Wants to list the files in a folder";
    case "git":
      return gitTitle(args);
    case "curl":
    case "wget":
      return curlTitle(args);
    case "ssh":
    case "scp": {
      const host = hostOf(operands.find((operand) => operand.includes("@")));
      return host ? `Wants to connect to ${host}` : null;
    }
    default:
      return PACKAGE_MANAGERS.has(tool) ? packageTitle(args) : null;
  }
}

const OUTSIDE_PROJECT = /^Outside the project folder:\s*(.+)$/s;

export function describeApprovalRequest(
  kind: ApprovalRequestKind,
  rawDetail: string | undefined,
): ApprovalDescription {
  const trimmed = rawDetail?.trim() ?? "";
  const detail = trimmed.length > 0 && !EMPTY_DETAILS.has(trimmed) ? trimmed : null;
  const generic = { title: GENERIC_TITLE[kind], detail, foldDetail: false };
  if (detail === null) return generic;

  if (kind === "command") {
    const command = detail.replace(TOOL_PREFIX, "");
    const title = plainCommandTitle(command);
    return title ? { title, detail: command, foldDetail: true } : { ...generic, detail: command };
  }
  if (kind === "file-change" || kind === "file-read") {
    const paths = detail.split("\n").filter(Boolean);
    const verb = kind === "file-change" ? "change" : "read";
    const single = paths.length === 1 && !/\s/.test(paths[0]!);
    if (paths.length > 1) {
      return { title: `Wants to ${verb} ${paths.length} files`, detail, foldDetail: true };
    }
    return single
      ? { title: `Wants to ${verb} ${baseName(paths[0]!)}`, detail, foldDetail: true }
      : generic;
  }
  const outside = OUTSIDE_PROJECT.exec(detail);
  if (outside) {
    return {
      title: "Wants to open a folder outside this project",
      detail: outside[1]!.trim(),
      foldDetail: false,
    };
  }
  return generic;
}
