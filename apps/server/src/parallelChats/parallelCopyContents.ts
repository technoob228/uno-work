/**
 * What a chat's copy gets besides the tracked files (spec section 2, "Что в
 * копию кладём"): the folder's ignored `.env*` files (else the app in the
 * copy doesn't start), its top `node_modules` as hard links (0.34 s and a few
 * MB instead of 2.6 s and 400 MB), and for a Claude chat that moves from the
 * folder its session transcript, so the session resumes in the copy.
 *
 * Other ignored things (`.venv`, `data/`, `dist/`) are not copied: the agent
 * builds them again or says a file is missing.
 *
 * @module parallelChats/parallelCopyContents
 */
import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import nodePath from "node:path";

import { Effect } from "effect";

import { claudeProjectDirName } from "./parallelRules.ts";

const ENV_FILES_MAX = 50;
const ENV_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Files package managers rewrite in place: a hard link would carry an
 * `npm i` in the copy into the folder (npm did exactly that with
 * `.package-lock.json`). Each gets an inode of its own in the copy.
 */
export const NODE_MODULES_OWN_FILES = [".package-lock.json", ".modules.yaml", ".yarn-integrity"];

const isInside = (parent: string, child: string) => {
  const relative = nodePath.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !nodePath.isAbsolute(relative);
};

/** Copy the listed `.env*` files (relative) from the folder into the copy; existing ones stay. */
export const copyEnvFiles = (root: string, copy: string, files: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    let copied = 0;
    for (const relative of files.slice(0, ENV_FILES_MAX)) {
      const source = nodePath.join(root, relative);
      const target = nodePath.join(copy, relative);
      if (!isInside(root, source) || !isInside(copy, target)) continue;
      const info = await lstat(source).catch(() => null);
      if (info === null) continue;
      if (
        await lstat(target).then(
          () => true,
          () => false,
        )
      )
        continue;
      await mkdir(nodePath.dirname(target), { recursive: true });
      if (info.isSymbolicLink()) {
        await symlink(await readlink(source), target).catch(() => undefined);
        copied++;
        continue;
      }
      if (!info.isFile() || info.size > ENV_FILE_MAX_BYTES) continue;
      await copyFile(source, target);
      await chmod(target, info.mode & 0o777);
      copied++;
    }
    return copied;
  });

const execFileQuiet = (file: string, args: ReadonlyArray<string>, timeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs }, (error) => resolve(error === null));
  });

/**
 * The folder's top `node_modules` into the copy: hard links on Linux
 * (`cp -al`), a clone on macOS (`cp -cR`, APFS). The package managers' own
 * files then get an inode of their own. False: not linked, the agent installs.
 */
export const linkNodeModules = (root: string, copy: string, timeoutMs = 15_000) =>
  Effect.promise(async () => {
    const source = nodePath.join(root, "node_modules");
    const target = nodePath.join(copy, "node_modules");
    const info = await lstat(source).catch(() => null);
    if (info === null || !info.isDirectory()) return false;
    if (
      await lstat(target).then(
        () => true,
        () => false,
      )
    )
      return false;
    const args = process.platform === "darwin" ? ["-cR", source, target] : ["-al", source, target];
    const ok = await execFileQuiet("cp", args, timeoutMs);
    if (!ok) {
      await rm(target, { recursive: true, force: true });
      return false;
    }
    for (const name of NODE_MODULES_OWN_FILES) {
      await breakHardLink(nodePath.join(target, name));
    }
    return true;
  });

/** Give a hard-linked file an inode of its own (same bytes and mode). */
export const breakHardLink = async (file: string) => {
  const info = await lstat(file).catch(() => null);
  if (info === null || !info.isFile()) return;
  const bytes = await readFile(file);
  const temp = `${file}.uno-${process.pid}.tmp`;
  await writeFile(temp, bytes, { mode: info.mode & 0o777 });
  await rename(temp, file);
};

/**
 * Claude Code finds a session by its cwd's project folder
 * (`<config>/projects/<enc(cwd)>/<id>.jsonl`): CLI 2.1.185 says "No
 * conversation found" from another folder, including a copy of a `.uno-git`
 * project. The transcript is copied to the copy's project folder; the one in
 * the folder's stays. True when the transcript is there afterwards.
 */
export const copyClaudeTranscript = (input: {
  readonly configDirs: ReadonlyArray<string>;
  readonly sessionId: string;
  readonly from: string;
  readonly to: string;
}) =>
  Effect.promise(async () => {
    if (!/^[A-Za-z0-9-]{8,80}$/.test(input.sessionId)) return false;
    const file = `${input.sessionId}.jsonl`;
    for (const configDir of new Set(input.configDirs.map((dir) => nodePath.resolve(dir)))) {
      const source = nodePath.join(configDir, "projects", claudeProjectDirName(input.from), file);
      const info = await lstat(source).catch(() => null);
      if (info === null || !info.isFile()) continue;
      const targetDir = nodePath.join(configDir, "projects", claudeProjectDirName(input.to));
      const target = nodePath.join(targetDir, file);
      await mkdir(targetDir, { recursive: true, mode: 0o700 });
      const temp = `${target}.uno-${process.pid}.tmp`;
      await copyFile(source, temp);
      await chmod(temp, 0o600);
      await rename(temp, target);
      return true;
    }
    return false;
  });

/**
 * Whether any process works inside `folder` (its cwd there): a dev server, a
 * terminal, an agent. Linux reads /proc; elsewhere the answer is "yes", so
 * nothing is removed there.
 */
export const processRunsIn = (folder: string) =>
  Effect.promise(async () => {
    if (process.platform !== "linux") return true;
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir("/proc").catch(() => null);
    if (entries === null) return true;
    const resolved = nodePath.resolve(folder);
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const cwd = await readlink(`/proc/${entry}/cwd`).catch(() => null);
      if (cwd !== null && (cwd === resolved || cwd.startsWith(`${resolved}${nodePath.sep}`))) {
        return true;
      }
    }
    return false;
  });
