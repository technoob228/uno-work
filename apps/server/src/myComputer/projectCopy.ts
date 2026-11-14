/**
 * A project folder of the person's computer, copied to this cloud computer
 * through the tunnel ("Continue in the cloud", "Bring your work").
 *
 * On the computer one command packs the folder (`tar -czf`, the system's own
 * tar: macOS, Linux and Windows 10+ all have one) into a file in its temp
 * folder, leaving out what is rebuilt anyway (`node_modules`, virtualenvs,
 * build caches) and never the git history. The file comes over in chunks,
 * is unpacked here, and is removed there. `.env` files are left out — every
 * `.env*`, templates too: keys go through the vault (the person picks them),
 * never as files. What the repository itself tracks of them is settled from
 * its own history afterwards (`settleTrackedEnvFiles`).
 *
 * @module myComputer/projectCopy
 */
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { MyComputerCore } from "./myComputerCore.ts";
import { MyComputerFailure } from "./myComputerCore.ts";
import { psQuote, shQuote } from "./workspaceTools.ts";

/** What isn't worth carrying: rebuilt from the project itself. */
export const COPY_EXCLUDES: ReadonlyArray<string> = [
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  ".turbo",
  ".cache",
  "dist",
  "target",
  ".DS_Store",
  ".env",
  ".env.*",
  // Keys and logins never travel as files, whatever folder holds them.
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".netrc",
  ".git-credentials",
  ".uno-connect",
];

/**
 * Printed by the pack command when asked for the home folder itself (or the
 * root): a chat started in "Home folder" would otherwise carry ~/.ssh,
 * ~/.aws and every private file of the person to the cloud (stand 03.11).
 */
export const COPY_HOME_REFUSED = "UNO_COPY_HOME";

export const HOME_NOT_COPIED =
  "The home folder isn't copied to the cloud: it holds the person's keys and private files. Only project folders come over.";

/** The biggest packed project carried over. */
export const COPY_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const PACK_TIMEOUT_MS = 20 * 60_000;

const isWindowsPath = (value: string) => /^[A-Za-z]:[\\/]/.test(value);

/** The command that packs `dir` and prints the archive's path and size. */
export function packCommand(dir: string, windows: boolean): string {
  if (windows) {
    const excludes = COPY_EXCLUDES.map((name) => `--exclude=${psQuote(name)}`).join(" ");
    return [
      `$d = (Resolve-Path -LiteralPath ${psQuote(dir)}).ProviderPath.TrimEnd('\\')`,
      `if ($d -eq $HOME.TrimEnd('\\') -or $d.Length -le 3) { Write-Output "${COPY_HOME_REFUSED}"; exit 4 }`,
      `$out = Join-Path $env:TEMP ("uno-copy-" + [guid]::NewGuid().ToString() + ".tgz")`,
      `tar -czf $out ${excludes} -C ${psQuote(dir)} .`,
      `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      `Write-Output ("UNO_COPY " + $out + " " + (Get-Item $out).Length)`,
    ].join("; ");
  }
  const excludes = COPY_EXCLUDES.map((name) => `--exclude=${shQuote(name)}`).join(" ");
  return [
    `d=$(cd ${shQuote(dir)} && pwd -P) || exit 2`,
    `if [ "$d" = "$(cd "$HOME" && pwd -P)" ] || [ "$d" = / ]; then echo ${COPY_HOME_REFUSED}; exit 4; fi`,
    `out=$(mktemp "\${TMPDIR:-/tmp}/uno-copy-XXXXXX") || exit 1`,
    `tar -czf "$out" ${excludes} -C ${shQuote(dir)} . || { rm -f "$out"; exit 3; }`,
    `printf 'UNO_COPY %s %s\\n' "$out" "$(wc -c < "$out" | tr -d ' ')"`,
  ].join("; ");
}

export function parsePackAnswer(
  text: string,
): { readonly file: string; readonly bytes: number } | null {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith("UNO_COPY "));
  if (line === undefined) return null;
  const rest = line.slice("UNO_COPY ".length).trim();
  const space = rest.lastIndexOf(" ");
  if (space <= 0) return null;
  const bytes = Number(rest.slice(space + 1));
  if (!Number.isFinite(bytes) || bytes < 0) return null;
  return { file: rest.slice(0, space), bytes };
}

const runTar = (args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("tar", [...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr.trim()}`)),
    );
  });

/**
 * Copy `source` (a folder on the computer) into `destination` here (created;
 * must be empty or missing). Resolves with the packed size.
 */
export async function copyFolderFromComputer(input: {
  readonly core: MyComputerCore;
  readonly computerId: string;
  readonly source: string;
  readonly destination: string;
  readonly threadId?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number) => void;
}): Promise<{ readonly bytes: number }> {
  const windows = isWindowsPath(input.source);
  const packed = await input.core.exec(
    {
      computerId: input.computerId,
      cmd: packCommand(input.source, windows),
      timeoutMs: PACK_TIMEOUT_MS,
      ...(input.threadId ? { threadId: input.threadId } : {}),
    },
    input.signal,
  );
  if (packed.text.includes(COPY_HOME_REFUSED)) {
    throw new MyComputerFailure("home-folder", HOME_NOT_COPIED);
  }
  const answer = parsePackAnswer(packed.text);
  if (packed.exitCode !== 0 || answer === null) {
    throw new MyComputerFailure(
      "remote",
      `Couldn't pack the folder on the computer (exit ${packed.exitCode ?? "?"}): ${packed.text.trim().slice(-300)}`,
    );
  }
  const removeThere = () =>
    input.core
      .exec({
        computerId: input.computerId,
        cmd: windows
          ? `Remove-Item -LiteralPath ${psQuote(answer.file)} -Force -ErrorAction SilentlyContinue`
          : `rm -f ${shQuote(answer.file)}`,
        timeoutMs: 30_000,
        quiet: true,
      })
      .catch(() => undefined);
  if (answer.bytes > COPY_MAX_BYTES) {
    await removeThere();
    throw new MyComputerFailure(
      "too-large",
      `The project is ${Math.round(answer.bytes / 1024 / 1024)} MB packed; up to ${COPY_MAX_BYTES / 1024 / 1024 / 1024} GB come over.`,
    );
  }
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "uno-copy-"));
  const archive = path.join(scratch, "project.tgz");
  try {
    const handle = await fsp.open(archive, "w", 0o600);
    try {
      let offset = 0;
      for (;;) {
        const chunk = await input.core.read(
          {
            computerId: input.computerId,
            path: answer.file,
            offset,
            maxBytes: CHUNK_BYTES,
            quiet: offset > 0,
            ...(input.threadId ? { threadId: input.threadId } : {}),
          },
          input.signal,
        );
        if (chunk.data.length > 0) await handle.write(chunk.data, 0, chunk.data.length, offset);
        offset += chunk.data.length;
        input.onProgress?.(offset, answer.bytes);
        if (chunk.eof || chunk.data.length === 0 || offset >= answer.bytes) break;
      }
    } finally {
      await handle.close();
    }
    await fsp.mkdir(input.destination, { recursive: true });
    // GNU and BSD tar both refuse members with `..` and drop a leading `/`.
    await runTar(["-xzf", archive, "-C", input.destination]);
    await settleTrackedEnvFiles(input.destination).catch(() => undefined);
    return { bytes: answer.bytes };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await removeThere();
  }
}

// ── Tracked `.env*` files after the copy ───────────────────────────────

/** Key-file templates a repository commits (as in the project move's `isCarriedEnvFileName`). */
const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist)$/;
const isEnvFileName = (name: string) => name === ".env" || name.startsWith(".env.");

/**
 * Plumbing only, nothing of the repository's own config runs: no hooks, no
 * fsmonitor (commands from the copied `.git/config` must not run here).
 */
const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...args],
      { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    const chunks: Array<Buffer> = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`git exited ${code}`)),
    );
  });

/**
 * The copy left every `.env*` file out, so git here sees the ones the
 * repository tracks as deleted — and an agent's `git add -A` would commit
 * that. Templates (`.env.example`, `.env.sample`…) are written back from the
 * repository's own index: the committed text, already here in `.git`, never
 * the laptop's file. Any other tracked `.env*` is marked skip-worktree: not
 * "deleted", and a file made here later isn't committed by accident.
 * Best effort; resolves with what it did.
 */
export async function settleTrackedEnvFiles(
  folder: string,
): Promise<{ readonly restored: ReadonlyArray<string>; readonly hidden: ReadonlyArray<string> }> {
  const none = { restored: [], hidden: [] };
  const isRepo = await fsp
    .stat(path.join(folder, ".git"))
    .then(() => true)
    .catch(() => false);
  if (!isRepo) return none;
  const deleted = (await runGit(folder, ["ls-files", "-z", "--deleted"]))
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0 && isEnvFileName(path.posix.basename(entry)));
  if (deleted.length === 0) return none;
  const root = await fsp.realpath(folder);
  const restored: Array<string> = [];
  const hidden: Array<string> = [];
  for (const entry of new Set(deleted)) {
    if (!ENV_TEMPLATE.test(path.posix.basename(entry))) {
      hidden.push(entry);
      continue;
    }
    const target = path.resolve(root, entry);
    // Inside the copy, through no symlink that leads out of it.
    const parent = await fsp.realpath(path.dirname(target)).catch(() => null);
    if (parent === null || (parent !== root && !parent.startsWith(`${root}${path.sep}`))) {
      hidden.push(entry);
      continue;
    }
    try {
      const blob = await runGit(folder, ["cat-file", "blob", `:${entry}`]);
      await fsp.writeFile(path.join(parent, path.basename(target)), blob, { flag: "wx" });
      restored.push(entry);
    } catch {
      hidden.push(entry);
    }
  }
  if (hidden.length > 0) {
    await runGit(folder, ["update-index", "--skip-worktree", "--", ...hidden]).catch(
      () => undefined,
    );
  }
  return { restored, hidden };
}
