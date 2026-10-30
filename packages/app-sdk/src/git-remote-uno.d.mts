// Types of git-remote-uno.mjs — the `uno::<name>` git remote helper (~/.uno/sdk/bin/git-remote-uno).

export declare const GIT_ROOT: string;
export declare const NAME_RE: RegExp;
export declare const MAX_BUNDLE_BYTES: number;
export declare const COMPACT_MAX_BUNDLES: number;
export declare const LOG_KEEP: number;
export declare const BUNDLE_GC_AGE_MS: number;
export declare const STALL_MS: number;
export declare const FAKE_STORAGE_ENV: string;
export declare const FAKE_TEAM_STORAGE_ENV: string;
export declare const FAKE_STORAGE_DELAY_ENV: string;
export declare const FAKE_FAULTS_ENV: string;
export declare const FAKE_UPLOAD_MINUTES_ENV: string;
export declare const COMMIT_DEADLINE_MS: number;
export declare const OUTCOME_UNKNOWN: string;
export declare const helperClock: { skewMs: number };
export declare const DEFAULT_CONSOLE_URL: string;
export declare const DAEMON_POINTER: string;
export declare const NOT_CLOUD: string;
export declare const SHALLOW: string;
export declare const OWNER_STORAGE_FULL: string;
export declare const NOT_SHARED_ANY_MORE: string;
export declare const TEAMS_OFF: string;

export declare class UnoGitError extends Error {}
export declare class ObjectExists extends UnoGitError {}

export declare function projectNameOf(raw: string): string | null;
export declare function addressOf(raw: string): { name: string; team: number | null } | null;
export declare function remoteUrl(name: string, team?: number | null): string;
export declare function slugName(raw: string): string | null;
export declare function logKey(name: string, seq: number): string;
export declare function bundleTime(key: string): number | null;

export declare function defaultSettingsFiles(home: string): string[];
export declare function machineCredentials(
  where: { home: string },
  fallbacks?: string[],
): { token: string; boxId: number | null; consoleUrl: string } | null;

export interface Storage {
  read(key: string): Promise<Buffer | null>;
  download(key: string, file: string): Promise<boolean>;
  /** False when `ifNoneMatch` and the key already exists (nothing written). */
  write(key: string, bytes: Buffer, options?: { ifNoneMatch?: boolean }): Promise<boolean>;
  upload(key: string, file: string, size: number): Promise<void>;
  list(prefix: string): Promise<{
    folders: string[];
    objects: Array<{ key: string; size: number; lastModified: number | null }>;
    truncated: boolean;
    /** Storage's own clock (ms), null when it doesn't say. */
    now: number | null;
  }>;
  remove(key: string): Promise<void>;
  who: { boxId: number | null; hostname: string };
  /** Someone else's project: new objects only, nothing removed. */
  shared?: boolean;
}

export declare function openStorage(where: {
  home: string;
  env: NodeJS.ProcessEnv;
  team?: number | null;
}): Storage;
export interface FakeStorageOptions {
  delayMs?: number;
  lostAnswer?: boolean;
  failReadBack?: boolean;
  uploadMinutes?: number;
  beforeConditionalWrite?: (key: string) => Promise<void>;
  truncateAfter?: number;
  nowMs?: () => number;
  shared?: boolean;
  ownerFull?: boolean;
  notShared?: boolean;
}
export declare function folderStorage(root: string, options?: FakeStorageOptions): Storage;
export declare function consoleStorage(
  creds: { token: string; boxId: number | null; consoleUrl: string },
  fetchImpl?: typeof fetch,
  team?: number | null,
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
  /** 0: no log yet (an empty project). */
  seq: number;
  refs: Record<string, string>;
  head: string | null;
  bundles: BundleEntry[];
  updatedAt: string | null;
  rev: string | null;
  updatedBy: { boxId: number | null; hostname: string } | null;
}

export declare function emptyState(): RemoteState;
export declare function readRemote(storage: Storage, name: string): Promise<RemoteState>;
export declare function checkState(name: string, raw: unknown, seq: number): RemoteState;
export declare function collectBundles(storage: Storage, name: string): Promise<number>;
export declare function pruneLog(storage: Storage, name: string): Promise<number>;
export declare function commitState(
  storage: Storage,
  name: string,
  before: RemoteState,
  next: Omit<RemoteState, "seq" | "rev" | "updatedAt" | "updatedBy">,
): Promise<{ key: string; bytes: Buffer } | null>;
export declare function pushRefs(input: {
  storage: Storage;
  name: string;
  specs: Array<{ force: boolean; src: string; dst: string }>;
  tmpDir: string;
  force: boolean;
  dryRun: boolean;
  progress: boolean;
  say: (line: string) => void;
}): Promise<Map<string, string>>;
export declare function bundlePrerequisites(file: string): Promise<string[]>;
export declare function cleanupNow(): void;
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
