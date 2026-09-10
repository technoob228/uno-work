/**
 * "Move this project to a box" — the environment-independent half.
 *
 * The flow is: clone the project's git remote into the target environment (or
 * create an empty directory there), optionally carry the root `.env` across,
 * then register the project in the target environment. Everything the flow
 * touches is injected so it can be tested without two live daemons.
 *
 * What is deliberately *not* moved: uncommitted work and untracked files. Git
 * is the transport, so anything not pushed stays behind — the caller says so
 * in the result and the UI repeats it in the final toast.
 */
import { joinWorkspacePath, normalizeProjectName } from "./firstProject";

export type MoveProjectToBoxMode = "clone" | "empty";

export interface MoveProjectToBoxDeps {
  /** Makes sure the target environment has a live connection before any RPC. */
  readonly ensureTargetConnected: () => Promise<void>;
  readonly cloneRepository: (input: {
    remoteUrl: string;
    destinationPath: string;
  }) => Promise<{ cwd: string }>;
  /** Reads a file from the *source* environment; null when it does not exist. */
  readonly readSourceFile: (
    absolutePath: string,
  ) => Promise<{ content: string; encoding: "utf8" | "base64" } | null>;
  readonly writeTargetFile: (input: {
    cwd: string;
    relativePath: string;
    contents: string;
    encoding: "utf8" | "base64";
  }) => Promise<unknown>;
  readonly createProject: (input: { cwd: string; title: string }) => Promise<void>;
  readonly onStep?: (step: MoveProjectToBoxStep) => void;
}

export type MoveProjectToBoxStep = "connecting" | "cloning" | "copying-env" | "creating-project";

export interface MoveProjectToBoxInput {
  readonly mode: MoveProjectToBoxMode;
  readonly projectName: string;
  /** Absolute path of the project in the source environment; `.env` is read from here. */
  readonly sourceCwd: string;
  /** Remote to clone; required in `clone` mode. */
  readonly remoteUrl?: string | null;
  /** Workspace root on the target box, e.g. `~/projects`. */
  readonly targetBaseDirectory: string;
  readonly copyEnv: boolean;
}

export interface MoveProjectToBoxResult {
  readonly mode: MoveProjectToBoxMode;
  readonly title: string;
  readonly cwd: string;
  /** True when a root `.env` was found and written on the target. */
  readonly envCopied: boolean;
  /** Set when `copyEnv` was requested but nothing was copied. */
  readonly envSkippedReason: string | null;
}

const ENV_FILE_NAME = ".env";

function joinSourcePath(cwd: string, fileName: string): string {
  return `${cwd.replace(/\/+$/, "")}/${fileName}`;
}

export function moveProjectDestination(input: {
  readonly projectName: string;
  readonly targetBaseDirectory: string;
}): { title: string; destinationPath: string } {
  const title = normalizeProjectName(input.projectName) || "project";
  return { title, destinationPath: joinWorkspacePath(input.targetBaseDirectory, title) };
}

/**
 * Runs the move and returns what actually happened. Failures of the *optional*
 * parts (the `.env` copy) are folded into the result rather than thrown: the
 * project is already on the box at that point, and losing it over a missing
 * secrets file would be worse than reporting the gap.
 */
export async function moveProjectToBox(
  deps: MoveProjectToBoxDeps,
  input: MoveProjectToBoxInput,
): Promise<MoveProjectToBoxResult> {
  const { title, destinationPath } = moveProjectDestination(input);

  deps.onStep?.("connecting");
  await deps.ensureTargetConnected();

  let cwd = destinationPath;
  if (input.mode === "clone") {
    const remoteUrl = input.remoteUrl?.trim() ?? "";
    if (remoteUrl.length === 0) {
      throw new Error("This project has no git remote, so there is nothing to clone.");
    }
    deps.onStep?.("cloning");
    const cloned = await deps.cloneRepository({ remoteUrl, destinationPath });
    cwd = cloned.cwd.trim().length > 0 ? cloned.cwd : destinationPath;
  }

  let envCopied = false;
  let envSkippedReason: string | null = null;
  if (input.copyEnv) {
    deps.onStep?.("copying-env");
    try {
      const file = await deps.readSourceFile(joinSourcePath(input.sourceCwd, ENV_FILE_NAME));
      if (file) {
        await deps.writeTargetFile({
          cwd,
          relativePath: ENV_FILE_NAME,
          contents: file.content,
          encoding: file.encoding,
        });
        envCopied = true;
      } else {
        envSkippedReason = "no .env file in the project root";
      }
    } catch (cause) {
      envSkippedReason = cause instanceof Error ? cause.message : String(cause);
    }
  }

  // The project entry is created last: in `empty` mode it is also what creates
  // the directory on the box, and in `clone` mode there is no point
  // registering a project whose clone failed.
  deps.onStep?.("creating-project");
  await deps.createProject({ cwd, title });

  return { mode: input.mode, title, cwd, envCopied, envSkippedReason };
}

/** One-line summary for the final toast: what landed on the box and what did not. */
export function describeMoveProjectResult(result: MoveProjectToBoxResult): string {
  const parts: string[] = [
    result.mode === "clone"
      ? `Cloned into ${result.cwd}`
      : `Created an empty project at ${result.cwd}`,
  ];
  if (result.envCopied) parts.push(".env copied");
  else if (result.envSkippedReason) parts.push(`.env not copied (${result.envSkippedReason})`);
  if (result.mode === "clone") parts.push("uncommitted changes stayed on this machine");
  return `${parts.join(" · ")}.`;
}
