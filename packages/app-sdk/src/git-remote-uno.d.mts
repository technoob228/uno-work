// Types of git-remote-uno.mjs — the `uno::<name>` git remote helper (~/.uno/sdk/bin/git-remote-uno).

export declare const GIT_ROOT: string;
export declare const NAME_RE: RegExp;
export declare const MAX_BUNDLE_BYTES: number;
export declare const COMPACT_MAX_BUNDLES: number;
export declare const FAKE_STORAGE_ENV: string;
export declare const DEFAULT_CONSOLE_URL: string;
export declare const DAEMON_POINTER: string;
export declare const NOT_CLOUD: string;

export declare class UnoGitError extends Error {}

export declare function projectNameOf(raw: string): string | null;
export declare function slugName(raw: string): string | null;

export declare function defaultSettingsFiles(home: string): string[];
export declare function machineCredentials(
  where: { home: string },
  fallbacks?: string[],
): { token: string; boxId: number | null; consoleUrl: string } | null;

export interface Storage {
  read(key: string): Promise<Buffer | null>;
  download(key: string, file: string): Promise<boolean>;
  write(key: string, bytes: Buffer): Promise<void>;
  upload(key: string, file: string, size: number): Promise<void>;
  list(
    prefix: string,
  ): Promise<{ folders: string[]; objects: Array<{ key: string; size: number }> }>;
  remove(key: string): Promise<void>;
  who: { boxId: number | null; hostname: string };
}

export declare function openStorage(where: { home: string; env: NodeJS.ProcessEnv }): Storage;
export declare function folderStorage(root: string): Storage;
export declare function consoleStorage(
  creds: { token: string; boxId: number | null; consoleUrl: string },
  fetchImpl?: typeof fetch,
): Storage;

export interface BundleEntry {
  key: string;
  created: string;
  size: number;
  tips: Record<string, string>;
  prerequisites: string[];
}

export interface RemoteState {
  version: 1;
  refs: Record<string, string>;
  head: string | null;
  bundles: BundleEntry[];
  updatedAt: string | null;
  rev: string | null;
  updatedBy: { boxId: number | null; hostname: string } | null;
}

export declare function emptyState(): RemoteState;
export declare function readRemote(storage: Storage, name: string): Promise<RemoteState>;
export declare function listProjects(storage: Storage): Promise<
  Array<{
    name: string;
    branches: number;
    head: string | null;
    updatedAt: string | null;
    updatedBy: { boxId: number | null; hostname: string } | null;
  }>
>;

export declare function git(
  args: string[],
  options?: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ code: number; stdout: string; stderr: string }>;

export declare function main(
  argv: string[],
  options?: { env?: NodeJS.ProcessEnv; home?: string },
): Promise<void>;
