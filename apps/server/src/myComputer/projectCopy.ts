/**
 * A project folder of the person's computer, copied to this cloud computer
 * through the tunnel ("Continue in the cloud", "Bring your work").
 *
 * On the computer one command packs the folder (`tar -czf`, the system's own
 * tar: macOS, Linux and Windows 10+ all have one) into a file in its temp
 * folder, leaving out what is rebuilt anyway (`node_modules`, virtualenvs,
 * build caches) and never the git history. The file comes over in chunks,
 * is unpacked here, and is removed there. `.env` files are left out: keys go
 * through the vault (the person picks them), never as files.
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
];

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
      `$out = Join-Path $env:TEMP ("uno-copy-" + [guid]::NewGuid().ToString() + ".tgz")`,
      `tar -czf $out ${excludes} -C ${psQuote(dir)} .`,
      `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      `Write-Output ("UNO_COPY " + $out + " " + (Get-Item $out).Length)`,
    ].join("; ");
  }
  const excludes = COPY_EXCLUDES.map((name) => `--exclude=${shQuote(name)}`).join(" ");
  return [
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
    return { bytes: answer.bytes };
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    await removeThere();
  }
}
