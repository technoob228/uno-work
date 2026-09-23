// Types for uno-app.mjs — the Uno App SDK (docs/app-sdk.md). Hand-written;
// keep in sync with the .mjs. The daemon copies both files to ~/.uno/sdk/js/.

export declare const DEFAULT_URL: string;

/** Error answered by the App API (`{"error":{"type","code","message"}}`), or a config problem (status 0). */
export declare class UnoAppError extends Error {
  constructor(status: number, code: string, message: string, type?: string);
  /** HTTP status; 0 when there was no response (config missing, API unreachable). */
  readonly status: number;
  /** `invalid_app_token` | `ai_not_allowed` | `app_limit_reached` | `ai_not_connected` | `invalid_request` | `cwd_outside_home` | `no_app_token` | `unreachable` | … */
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
  ai: { chat: boolean; tasks: boolean; limitUsd: number; spentUsd: number; remainingUsd: number };
  defaults: { chatModel: string; taskHarness: string };
  home: string;
  [key: string]: unknown;
}

export interface TranscriptionJson {
  text: string;
  segments?: Array<{ start: number; end: number; text: string; [key: string]: unknown }>;
  [key: string]: unknown;
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
