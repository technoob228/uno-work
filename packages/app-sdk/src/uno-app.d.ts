// Types for uno-app.mjs — the Uno App SDK (docs/app-sdk.md). Hand-written;
// keep in sync with the .mjs. The daemon copies both files to ~/.uno/sdk/js/.

export declare const DEFAULT_URL: string;

/** Error answered by the App API (`{"error":{"type","code","message"}}`), or a config problem (status 0). */
export declare class UnoAppError extends Error {
  constructor(status: number, code: string, message: string, type?: string);
  /** HTTP status; 0 when there was no response (config missing, API unreachable). */
  readonly status: number;
  /** `invalid_app_token` | `ai_not_allowed` | `app_limit_reached` | `ai_not_connected` | `invalid_request` | `cwd_outside_home` | `no_app_token` | `unreachable` | `storage_not_allowed` | `app_storage_full` | `cloud_full` | `file_not_found` | `invalid_key` | `storage_not_connected` | … */
  readonly code: string;
  readonly type: string;
}

export interface ClientOptions {
  /** App API base URL. Default: env UNO_APP_API_URL, the key folder's api.json, then http://127.0.0.1:3779. */
  url?: string;
  /** Bearer token. Default: env UNO_APP_TOKEN, then the key folder. */
  token?: string;
  /** App id, used to find ~/.uno/app-keys/<appId>/. Default: env UNO_APP_ID. */
  appId?: string;
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
}

export interface ResolvedConfig {
  url: string;
  token: string;
  appId: string;
  /** "options" | "env" | the key folder the token came from. */
  source: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | (string & {});
  content: unknown;
  [key: string]: unknown;
}

export type PromptInput = string | ReadonlyArray<ChatMessage>;

export interface AskOptions {
  /** Gateway model id; omitted or "default" = the model the person picked for apps. */
  model?: string;
  /** Prepended as a system message. */
  system?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface TranscribeOptions {
  /** Speech-to-text model id; omitted = the App API's default. */
  model?: string;
  /** ISO-639-1 hint, e.g. "en". */
  language?: string;
  /** File name sent with the upload (default: the path's basename or "audio"). */
  filename?: string;
  /** Only for transcribeJson(): "json" (default) | "verbose_json" | … */
  responseFormat?: string;
  signal?: AbortSignal;
}

export type AudioInput = string | Blob | ArrayBuffer | ArrayBufferView;

export type TaskTools = "read" | "ask" | "edit" | "full";
export type TaskStatus = "running" | "waiting" | "done" | "error" | "stopped";

export interface TaskSpec {
  prompt: string;
  /** Inside the home folder; default the app's cwd, else home. */
  cwd?: string;
  title?: string;
  /** "default" or a harness id (uno, codex, claudeAgent, opencode, …). */
  harness?: string;
  /** What the agent may do on its own (default "ask"); narrowed to what the person allows. */
  tools?: TaskTools;
  signal?: AbortSignal;
}

export interface TaskState {
  id: string;
  threadId: string;
  status: TaskStatus;
  tools?: TaskTools;
  harness?: string;
  result?: { text: string } | null;
  changedFiles?: string[];
  waitingFor?: "approval" | "input" | null;
  [key: string]: unknown;
}

export type TaskEvent =
  | { event: "status"; data: { status: TaskStatus } }
  | { event: "message"; data: { delta: string } }
  | { event: "activity"; data: { kind: string; summary: string; [key: string]: unknown } }
  | { event: "done"; data: TaskState }
  | { event: string; data: unknown };

export interface WaitOptions {
  /** Give up after this long and resolve with the latest state (default: wait forever). */
  timeoutMs?: number;
  /**
   * true (default): keep waiting while the task is "waiting" for the person
   * (they approve in Work). false: resolve as soon as it stops running.
   */
  untilDone?: boolean;
  signal?: AbortSignal;
}

export interface UnoTask extends TaskState {
  /** Long-polls until the task ends (see WaitOptions); resolves with the final task JSON. */
  wait(opts?: WaitOptions): Promise<TaskState>;
  /** Server-Sent Events of the task; ends after the `done` event. */
  events(opts?: { signal?: AbortSignal }): AsyncGenerator<TaskEvent>;
  stop(): Promise<unknown>;
}

export interface WhoAmI {
  app: { id: string; name: string };
  ai: {
    chat: boolean;
    tasks: boolean;
    limitUsd: number;
    /** Everything counted against the limit: answers + jobs. */
    spentUsd: number;
    /** Answers and transcription. */
    chatSpentUsd?: number;
    /** Agent tasks on the Uno AI gateway (not on the person's own subscription). */
    tasksSpentUsd?: number;
    remainingUsd: number;
  };
  storage: { enabled: boolean; limitBytes?: number; usedBytes?: number | null };
  defaults: { chatModel: string; taskHarness: string };
  home: string;
  [key: string]: unknown;
}

export interface TranscriptionJson {
  text: string;
  segments?: Array<{ start: number; end: number; text: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface StorageFile {
  /** Relative to the app's folder, e.g. "photos/2026/cat.jpg". */
  key: string;
  name: string;
  size: number;
  modifiedAt: string | null;
}

export interface StorageListing {
  prefix: string;
  /** Sub-folders, each ending in "/". */
  folders: string[];
  files: StorageFile[];
  truncated: boolean;
}

export interface StorageUsage {
  /** Where the person finds the files: "Cloud storage → apps/<id>/". */
  folder: string;
  bucketId: number;
  usedBytes: number;
  files: number;
  limitBytes: number;
  remainingBytes: number;
}

export type StorageData = string | Blob | ArrayBuffer | ArrayBufferView;

/**
 * The app's own folder in the Uno account's cloud (manifest `"storage"`).
 * Keys are relative to that folder: "photos/2026/cat.jpg". One file ≤ 256 MB.
 */
export interface UnoStorage {
  /** Save bytes/text under a key (overwrites). Content-Type from `contentType` or the extension. */
  put(
    key: string,
    data: StorageData,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<{ key: string; size: number }>;
  putJson(key: string, value: unknown): Promise<{ key: string; size: number }>;
  /** Upload a file from disk, streamed (Node/Bun). `key` defaults to the file name. */
  upload(
    localPath: string,
    key?: string,
    opts?: { contentType?: string; signal?: AbortSignal },
  ): Promise<{ key: string; size: number }>;
  /** Raw Response with a streaming body; `range` = an HTTP Range header ("bytes=0-1023"). */
  open(key: string, opts?: { range?: string; signal?: AbortSignal }): Promise<Response>;
  get(key: string): Promise<Uint8Array>;
  getText(key: string): Promise<string>;
  getJson<T = unknown>(key: string): Promise<T>;
  /** Download to a file on disk (Node/Bun); resolves with the path. */
  download(key: string, localPath: string): Promise<string>;
  exists(key: string): Promise<boolean>;
  /** One folder level ("" = the app's whole folder). */
  list(prefix?: string): Promise<StorageListing>;
  /** Every file under a folder, walking sub-folders. */
  listAll(prefix?: string): Promise<StorageFile[]>;
  /** Delete a file, or a whole folder when the key ends in "/". */
  delete(key: string): Promise<{ deleted: number }>;
  /** Temporary https link (default 15 min, max 1 h) for <img src>, <a href> or a redirect. */
  url(key: string, opts?: { expiresIn?: number }): Promise<string>;
  usage(): Promise<StorageUsage>;
}

/** Where "Open" on a notification leads. */
export type NotifyOpen = { file: string } | { url: string } | { app: true; path?: string } | string;

export interface NotifyInput {
  /** One line, at most 140 characters: "Boris commented on report.docx". */
  title: string;
  /** Optional second line, at most 500 characters. */
  body?: string;
  open?: NotifyOpen;
  /** Same group while unread → the item updates instead of stacking. */
  group?: string;
}

export interface UnoAppClient {
  /** One answer as text. */
  ask(input: PromptInput, opts?: AskOptions): Promise<string>;
  /** Text deltas as they arrive. */
  stream(input: PromptInput, opts?: AskOptions): AsyncGenerator<string>;
  /** Raw OpenAI-compatible POST /v1/chat/completions; returns the parsed JSON. */
  chat(body: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<any>;
  /** Speech to text. A string is a file path (Node/Bun). */
  transcribe(file: AudioInput, opts?: TranscribeOptions): Promise<string>;
  /** Same, returns the whole JSON (for response_format "verbose_json" segments). */
  transcribeJson(file: AudioInput, opts?: TranscribeOptions): Promise<TranscriptionJson>;
  /** Start an agent task (a Work chat the person can see and stop). */
  task(spec: TaskSpec): Promise<UnoTask>;
  getTask(id: string): Promise<UnoTask>;
  /** The app's own tasks. */
  tasks(): Promise<any>;
  whoami(): Promise<WhoAmI>;
  models(): Promise<any>;
  /** Put a notification into the person's Inbox (manifest `"notify": true`). */
  notify(
    input: string | NotifyInput,
    opts?: Omit<NotifyInput, "title">,
  ): Promise<{ ok: true; id: string }>;
  /** The app's folder in the account's cloud — for files the person keeps. */
  storage: UnoStorage;
  /** Resolved address + token (waits up to 15 s for the daemon to write the key). */
  config(): Promise<ResolvedConfig>;
}

export declare function createClient(options?: ClientOptions): UnoAppClient;

export declare function resolveConfig(
  options?: ClientOptions & { waitMs?: number },
): Promise<ResolvedConfig>;

export declare function parseSSE(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<{ event: string; data: string }>;

export declare const ask: UnoAppClient["ask"];
export declare const stream: UnoAppClient["stream"];
export declare const chat: UnoAppClient["chat"];
export declare const transcribe: UnoAppClient["transcribe"];
export declare const transcribeJson: UnoAppClient["transcribeJson"];
export declare const task: UnoAppClient["task"];
export declare const getTask: UnoAppClient["getTask"];
export declare const tasks: UnoAppClient["tasks"];
export declare const whoami: UnoAppClient["whoami"];
export declare const models: UnoAppClient["models"];
export declare const notify: UnoAppClient["notify"];
export declare const storage: UnoStorage;
export declare function guessContentType(name: string): string;
