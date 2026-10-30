// Types of uno-sync.mjs — "a project lives on all your computers".
import type { Storage } from "./git-remote-uno.mjs";

export declare const SYNC_DIR: string;
export declare const MAX_PROJECT_BYTES: number;
export declare const MAX_FILE_BYTES: number;
export declare const LOCK_STALE_MS: number;
export declare const DEFAULT_EXCLUDES: ReadonlyArray<string>;
export declare const SECRET_PATTERN: RegExp;
export declare const BUILD_FOLDERS: ReadonlyArray<string>;

export declare function isKeyFile(relative: string): boolean;
export declare function builtFolders(files: string[]): string[];
export declare function heldMessage(files: string[]): string;
export declare function safeRelative(raw: unknown): string | null;
export declare function safeRemoteUrl(raw: unknown): string | null;
export declare const SNAPSHOT_GIT_DIR: string;
export declare function snapshotGitDir(dir: string): string;
export declare function defaultName(dir: string): string;
export declare function ensureHelperLauncher(home: string): Promise<string>;
export declare function ownGit(
  dir: string,
  env: NodeJS.ProcessEnv,
): Promise<{ top: string; gitDir: string } | null>;

export type SyncState = "synced" | "conflict" | "too-big" | "blocked" | "busy" | "error" | "empty";

export interface ConflictRecord {
  files: string[];
  kept: Record<string, "mine" | "theirs">;
  mine: string;
  theirs: string;
  theirsFrom: string | null;
  at: string;
}

export interface SyncResult {
  ok: boolean;
  name: string;
  dir: string;
  mode: "snapshot" | "git";
  state: SyncState;
  pushed: boolean;
  pulled: boolean;
  changedFiles: number;
  head: string | null;
  conflict: ConflictRecord | null;
  /** Files with something that looks like a key inside: they wait on this computer. */
  held: string[];
  message: string;
}

export interface ProjectMeta {
  mode: "snapshot" | "git";
  remotes?: Record<string, string>;
  folderName?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface SyncCtx {
  home: string;
  env: NodeJS.ProcessEnv;
  hostname?: string;
  /** The name on the versions this computer saves. */
  person?: string | null;
  now?: () => number;
  storage?: Storage;
}

export declare class SyncError extends Error {
  readonly state: SyncState;
}

export declare function readMeta(storage: Storage, name: string): Promise<ProjectMeta | null>;
export declare function writeMeta(storage: Storage, name: string, meta: ProjectMeta): Promise<void>;
export declare function readConflict(gitDir: string): Promise<ConflictRecord | null>;

export declare function syncProject(
  input: { dir: string; name?: string | null; adopt?: boolean; reason?: string },
  ctx: SyncCtx,
): Promise<SyncResult>;

export declare function resolveConflict(
  input: { dir: string; name: string; keep: "mine" | "theirs" | "dismiss" },
  ctx: SyncCtx,
): Promise<SyncResult>;

export declare function versionAuthor(ctx: SyncCtx): string;

export interface ProjectVersion {
  id: string;
  at: string;
  person: string | null;
  computer: string | null;
  note: string | null;
  files: Array<{ path: string; change: "added" | "changed" | "removed" }>;
  moreFiles: number;
}

export declare function projectHistory(
  input: { dir: string; skip?: number; limit?: number },
  ctx: SyncCtx,
): Promise<{ mode: "snapshot" | "git"; versions: ProjectVersion[]; more: boolean }>;

export declare function restoreVersion(
  input: { dir: string; name: string; version: string; files?: string[] | null },
  ctx: SyncCtx,
): Promise<SyncResult>;

export declare function projectFiles(
  input: { dir: string },
  ctx: SyncCtx,
): Promise<{
  mode: "snapshot" | "git";
  synced: number;
  localOnly: Array<{ path: string; yours: boolean }>;
  keyFiles: string[];
  more: number;
}>;

export declare function setLocalOnly(
  input: { dir: string; path: string; localOnly: boolean },
  ctx: SyncCtx,
): Promise<void>;

export declare function getProject(
  input: { name: string; dir?: string | null },
  ctx: SyncCtx,
): Promise<SyncResult>;

export declare function listCloudProjects(ctx: SyncCtx): Promise<
  Array<{
    name: string;
    branches: number;
    head: string | null;
    updatedAt: string | null;
    updatedBy: { boxId: number | null; hostname: string } | null;
    mode: "snapshot" | "git";
  }>
>;
