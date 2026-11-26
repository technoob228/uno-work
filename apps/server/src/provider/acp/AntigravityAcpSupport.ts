/**
 * AntigravityAcpSupport — Google Antigravity's official ACP agent
 * (`agy acp`, the Antigravity CLI) in Uno Work. Ported from upstream T3 Code
 * (pingdotgg/t3code, MIT: provider/acp/Antigravity*.ts,
 * antigravityAuthSupport.ts) and checked live against 1.5.16 on 24.11.2026:
 *
 *   - `initialize` answers in ~0.2 s: `agentInfo.name` "Antigravity ACP
 *     Server", `loadSession`, `sessionCapabilities.resume`, `auth.logout`,
 *     image prompts, `_meta.antigravity.systemPrompt.append`; auth methods
 *     `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform`.
 *   - Without a sign-in, `authenticate oauth-personal` answers -32603 "No
 *     browser is available here … Run `agy acp --login`" and `session/new`
 *     -32000 "Authentication required".
 *   - `agy acp --login` prints a Google link (redirect
 *     https://antigravity.google/oauth-callback) and reads the code that page
 *     shows (or the page's full URL) from stdin, then exits.
 *   - Where it keeps the sign-in: the OS keyring (macOS Keychain service
 *     "gemini", account "antigravity"; shared with the Antigravity app and the
 *     terminal `agy` on that computer), or — over SSH or without a keyring —
 *     the file `<gemini dir>/<app data dir>/antigravity-oauth-token`.
 *
 * Unlike upstream, which gives every instance a private profile and its own
 * sign-in, Uno Work runs the computer's own Antigravity: `~/.gemini`, app data
 * `antigravity-cli` (the terminal CLI's), so an Antigravity already signed in
 * on this computer works without a second sign-in (Misha, T58/T66).
 *
 * @module AntigravityAcpSupport
 */
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderOptionSelection,
  type UserInputQuestion,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { UNO_WORK_MCP_SERVER_NAME } from "../../unoWork/constants.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";
import { optionOfKinds } from "./AcpAdapterSupport.ts";

export const ANTIGRAVITY_DRIVER_KIND = "antigravity";
export const ANTIGRAVITY_DISPLAY_NAME = "Antigravity";
/** The terminal CLI's app data folder (`agy acp --app-data-dir`'s default). */
export const ANTIGRAVITY_APP_DATA_DIR = "antigravity-cli";
export const ANTIGRAVITY_ACP_ARGS: ReadonlyArray<string> = ["acp"];
export const ANTIGRAVITY_LOGIN_ARGS: ReadonlyArray<string> = ["acp", "--login"];
export const ANTIGRAVITY_AGENT_NAME = "Antigravity ACP Server";

/** Instance variable for a Gemini API key (never the ambient GEMINI_API_KEY). */
export const ANTIGRAVITY_API_KEY_ENV = "ANTIGRAVITY_GEMINI_API_KEY";
export const ANTIGRAVITY_AUTH_METHOD_GOOGLE = "oauth-personal";
export const ANTIGRAVITY_AUTH_METHOD_API_KEY = "gemini-api-key";

/** initialize → session/new (MCP servers connect in it). */
export const ANTIGRAVITY_START_TIMEOUT_MS = 120_000;
export const ANTIGRAVITY_SESSION_LOAD_TIMEOUT_MS = 60_000;

/** Older than this: `session/new` refuses; upstream asks for 1.5, recommends 1.5.12. */
export const ANTIGRAVITY_MIN_VERSION = [1, 5, 0] as const;
/** `agy acp` 1.5.1 offers every model to every client; older ones only to allowlisted editors. */
const OPEN_MODEL_ACCESS_RELEASE = [1, 5, 1] as const;

export const ANTIGRAVITY_SIGN_IN_HINT =
  "Sign in on this computer: Settings → AI → Antigravity → Sign in (Google account or a Gemini API key).";

/* ------------------------------------------------------------------ *
 * Versions, client name
 * ------------------------------------------------------------------ */

export function parseAntigravityVersion(
  version: string | null | undefined,
): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? "");
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareAntigravityVersions(
  left: ReadonlyArray<number>,
  right: ReadonlyArray<number>,
): number {
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function isAntigravityVersionSupported(version: string | null | undefined): boolean {
  const parsed = parseAntigravityVersion(version);
  return parsed === undefined || compareAntigravityVersions(parsed, ANTIGRAVITY_MIN_VERSION) >= 0;
}

/** Older releases offer non-Gemini models (Claude, GPT) only to allowlisted clients such as Zed. */
export function antigravityClientInfo(version: string | null | undefined, clientVersion: string) {
  const parsed = parseAntigravityVersion(version);
  return parsed !== undefined && compareAntigravityVersions(parsed, OPEN_MODEL_ACCESS_RELEASE) >= 0
    ? { name: "uno-work", version: clientVersion }
    : { name: "zed", version: "0.0.0" };
}

/* ------------------------------------------------------------------ *
 * Where the sign-in lives, the process environment
 * ------------------------------------------------------------------ */

/** The computer's Antigravity folder (`--gemini-dir`'s default `~/.gemini`). */
export function antigravityGeminiDir(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  return env.GEMINI_HOME?.trim() || nodePath.join(home, ".gemini");
}

export function antigravityTokenFile(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  return nodePath.join(
    antigravityGeminiDir(env, home),
    ANTIGRAVITY_APP_DATA_DIR,
    "antigravity-oauth-token",
  );
}

/**
 * Credentials and switches that must not reach the agent from the daemon's
 * environment: the sign-in is the one chosen in Settings → AI, not whatever
 * key the computer happens to export (upstream T3 Code).
 */
const REMOVED_ENVIRONMENT_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "AGY_ACP_ENABLE_OAUTH",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "AGY_CLI_DISABLE_AUTO_UPDATE",
  "ELECTRON_RUN_AS_NODE",
  "CHROME_CRASHPAD_PIPE_NAME",
  ANTIGRAVITY_API_KEY_ENV,
]);

export type AntigravityCredentialStore = "file" | "keyring";

/**
 * Environment of an `agy` process. `store: "file"` makes the CLI read and
 * write the sign-in file instead of the OS keyring: it believes it runs over
 * SSH (the 1.5 CLI ignores AGY_ACP_FORCE_FILE_STORAGE otherwise — upstream).
 * Linux always uses the file (a cloud computer has no keyring); a Mac or
 * Windows uses its keyring unless the sign-in was made in Uno Work into the
 * file.
 */
export function antigravityProcessEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  options: { readonly store: AntigravityCredentialStore; readonly caBundlePath?: string },
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!REMOVED_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
  }
  const apiKey = baseEnv[ANTIGRAVITY_API_KEY_ENV]?.trim();
  return {
    ...environment,
    ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}),
    ...(options.caBundlePath && !baseEnv.SSL_CERT_FILE && !baseEnv.SSL_CERT_DIR
      ? { SSL_CERT_FILE: options.caBundlePath }
      : {}),
    ...(options.store === "file"
      ? {
          SSH_CONNECTION: baseEnv.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
          AGY_ACP_FORCE_FILE_STORAGE: "1",
        }
      : {}),
    // Settings → AI → Antigravity → Update replaces the runtime, never the agent mid-chat.
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    PYTHONUNBUFFERED: "1",
  };
}

/** Bundled TLS may look for certificates where this Linux keeps none (upstream). */
const LINUX_CA_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/certs/ca-bundle.crt",
  "/etc/ssl/cert.pem",
];

export async function findLinuxCaBundle(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  for (const candidate of [env.NIX_SSL_CERT_FILE, ...LINUX_CA_BUNDLES]) {
    if (candidate && nodePath.isAbsolute(candidate) && (await isFile(candidate))) return candidate;
  }
  return undefined;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Sign-in state
 * ------------------------------------------------------------------ */

export type AntigravityAuthType = "google-file" | "google-keyring" | "gemini-api-key";

export interface AntigravityAuthState {
  readonly status: "authenticated" | "unauthenticated";
  readonly type?: AntigravityAuthType;
  readonly label?: string;
  readonly message?: string;
}

export interface AntigravityAuthEvidence {
  /** A Gemini API key stored for this instance. */
  readonly apiKey: boolean;
  /** The sign-in file holds a token. */
  readonly tokenFile: boolean;
  /** The OS keyring holds Antigravity's sign-in (Mac, Windows). */
  readonly keyring: boolean;
}

/** Pure: the sign-in a chat will use. The API key wins (upstream), then the file, then the keyring. */
export function describeAntigravityAuth(evidence: AntigravityAuthEvidence): AntigravityAuthState {
  if (evidence.apiKey) {
    return { status: "authenticated", type: "gemini-api-key", label: "Gemini API key" };
  }
  if (evidence.tokenFile) {
    return { status: "authenticated", type: "google-file", label: "Google account" };
  }
  if (evidence.keyring) {
    return {
      status: "authenticated",
      type: "google-keyring",
      label: "Google account (this computer's Antigravity)",
    };
  }
  return {
    status: "unauthenticated",
    message: "Sign in with Google or add a Gemini API key.",
  };
}

/** `{"token":{"access_token":…}}` — a sign-in the CLI wrote (upstream's CliToken). */
export function hasAntigravityToken(text: string | undefined): boolean {
  if (!text?.trim()) return false;
  try {
    const parsed = JSON.parse(text) as {
      token?: { access_token?: unknown; refresh_token?: unknown };
    };
    const token = parsed?.token;
    return (
      typeof token === "object" &&
      token !== null &&
      ((typeof token.refresh_token === "string" && token.refresh_token.length > 0) ||
        (typeof token.access_token === "string" && token.access_token.length > 0))
    );
  } catch {
    // Not JSON we know, but not empty: let the CLI judge it.
    return true;
  }
}

async function readSmallText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export async function hasAntigravityTokenFile(env: NodeJS.ProcessEnv): Promise<boolean> {
  return hasAntigravityToken(await readSmallText(antigravityTokenFile(env)));
}

/**
 * The keyring item the CLI and the Antigravity app keep the Google sign-in in
 * (go-keyring: service "gemini", account "antigravity" — upstream's usage
 * reader). Looking it up reads only its attributes: no Keychain prompt.
 */
export function probeAntigravityKeyring(
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const run = (command: string, args: ReadonlyArray<string>, match?: RegExp) =>
    new Promise<boolean>((resolve) => {
      execFile(command, [...args], { timeout: 5_000, windowsHide: true }, (error, stdout) => {
        if (error) return resolve(false);
        resolve(match ? match.test(String(stdout)) : true);
      });
    });
  if (platform === "darwin") {
    return run("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity"]);
  }
  if (platform === "win32") {
    return run("cmdkey", ["/list:gemini:antigravity"], /gemini:antigravity/i);
  }
  return Promise.resolve(false);
}

export async function probeAntigravityAuth(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<AntigravityAuthState> {
  const apiKey = Boolean(env[ANTIGRAVITY_API_KEY_ENV]?.trim());
  const tokenFile = apiKey ? false : await hasAntigravityTokenFile(env);
  const keyring = apiKey || tokenFile ? false : await probeAntigravityKeyring(platform);
  return describeAntigravityAuth({ apiKey, tokenFile, keyring });
}

/** Linux keeps the sign-in in the file; a Mac or Windows in its keyring unless Uno Work wrote the file. */
export async function antigravityCredentialStore(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): Promise<AntigravityCredentialStore> {
  if (platform !== "darwin" && platform !== "win32") return "file";
  return (await hasAntigravityTokenFile(env)) ? "file" : "keyring";
}

export function antigravityAuthMethodFor(env: NodeJS.ProcessEnv): string {
  return env[ANTIGRAVITY_API_KEY_ENV]?.trim()
    ? ANTIGRAVITY_AUTH_METHOD_API_KEY
    : ANTIGRAVITY_AUTH_METHOD_GOOGLE;
}

/** Refuse a chat that would only fail with "Authentication required". */
export async function antigravityPreflight(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const auth = await probeAntigravityAuth(env);
  return auth.status === "unauthenticated"
    ? `Antigravity is not signed in on this computer. ${ANTIGRAVITY_SIGN_IN_HINT}`
    : undefined;
}

/** The agent's own "not signed in" answers (upstream isAntigravitySignInRequiredError). */
export function isAntigravitySignInRequiredText(text: string): boolean {
  return /Authentication required|No browser is available here|agy acp --login/i.test(text);
}

/* ------------------------------------------------------------------ *
 * Google sign-in (`agy acp --login`)
 * ------------------------------------------------------------------ */

/** Where `agy acp --login` sends Google; the page shows the code to paste back. */
export const ANTIGRAVITY_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";
const MAX_AUTHORIZATION_URL_LENGTH = 16_384;

export interface AntigravityAuthorizationUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
  /** `code`: the page shows a code to paste; `loopback`: the browser comes back to this computer. */
  readonly kind: "code" | "loopback";
}

/** A Google sign-in link of the shape the CLI prints, or undefined (upstream's checks). */
export function parseAntigravityAuthorizationUrl(
  candidate: string,
): AntigravityAuthorizationUrl | undefined {
  if (candidate.length > MAX_AUTHORIZATION_URL_LENGTH || /\s/.test(candidate)) return undefined;
  const url = URL.parse(candidate);
  if (url === null) return undefined;
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  const loopbackPort =
    redirectUri === null
      ? undefined
      : /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(redirectUri)?.[1];
  const loopback = loopbackPort !== undefined && Number(loopbackPort) <= 65_535;
  const code = redirectUri === ANTIGRAVITY_CODE_REDIRECT_URI;
  if (
    url.origin !== "https://accounts.google.com" ||
    !/^\/o\/oauth2\/(v2\/)?auth$/.test(url.pathname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    !state ||
    state.length > 512 ||
    redirectUri === null ||
    (!loopback && !code)
  ) {
    return undefined;
  }
  return { authorizationUrl: candidate, redirectUri, state, kind: code ? "code" : "loopback" };
}

/** The first Google sign-in link in the CLI's output. */
export function findAntigravityAuthorizationUrl(
  output: string,
): AntigravityAuthorizationUrl | undefined {
  for (const match of output.matchAll(/https:\/\/accounts\.google\.com\/\S+/g)) {
    const parsed = parseAntigravityAuthorizationUrl(match[0]);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * What `agy acp --login` may read after its link: the code the Antigravity
 * page shows, or that page's URL answering this very sign-in. Undefined for
 * anything else, including a line break (it would answer a second prompt).
 */
export function antigravityLoginResponse(
  pending: Pick<AntigravityAuthorizationUrl, "redirectUri" | "state">,
  response: string,
): string | undefined {
  const value = response.trim();
  if (/^[\w./~-]{1,2048}$/.test(value)) return value;
  if (value.length > MAX_AUTHORIZATION_URL_LENGTH || /\s/.test(value)) return undefined;
  const url = URL.parse(value);
  if (
    url === null ||
    `${url.origin}${url.pathname}` !== pending.redirectUri ||
    url.username !== "" ||
    url.password !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code")
  ) {
    return undefined;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Modes, permissions
 * ------------------------------------------------------------------ */

/**
 * agy refuses `yolo` / `auto_edit` as session modes; sessions stay in
 * `default`, where it asks before acting and Uno Work answers by the chat's
 * permission mode, so a mode change applies on the next request without a
 * restart (upstream antigravitySessionMode).
 */
export function antigravityModeFor(input: {
  readonly modeState: { readonly availableModeIds: ReadonlyArray<string> };
}): string | undefined {
  return input.modeState.availableModeIds.includes("default") ? "default" : undefined;
}

/** Native questions share the permission method; their choices are not approvals (upstream). */
export function isAntigravityUserInputRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  return request.toolCall.toolCallId.startsWith("interaction_");
}

const QUESTION_TEXT_LIMIT = 8_000;
const QUESTION_LABEL_LIMIT = 512;

function boundText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 3).replace(/[\uD800-\uDBFF]$/u, "")}...`;
}

function questionLabel(option: EffectAcpSchema.PermissionOption): string {
  return boundText(option.name.trim() || option.optionId, QUESTION_LABEL_LIMIT);
}

/**
 * The label of each choice as the card shows it. Uno Work answers a question
 * with the chosen label, so two choices with one name get their place added.
 */
function questionLabels(options: ReadonlyArray<EffectAcpSchema.PermissionOption>): string[] {
  const labels = options.map(questionLabel);
  return labels.map((label, index) =>
    labels.indexOf(label) === index && labels.lastIndexOf(label) === index
      ? label
      : `${label} (${index + 1})`,
  );
}

function validQuestionOptions(request: EffectAcpSchema.RequestPermissionRequest): boolean {
  if (!isAntigravityUserInputRequest(request) || request.options.length === 0) return false;
  const ids = new Set<string>();
  for (const option of request.options) {
    if (!option.optionId.trim() || ids.has(option.optionId)) return false;
    ids.add(option.optionId);
  }
  return true;
}

/** An Antigravity question as a Uno Work question card, or undefined when it is not one. */
export function extractAntigravityUserInputQuestion(
  request: EffectAcpSchema.RequestPermissionRequest,
): UserInputQuestion | undefined {
  if (!validQuestionOptions(request)) return undefined;
  const question = request.toolCall.title?.trim() || "Choose an option.";
  const labels = questionLabels(request.options);
  return {
    id: request.toolCall.toolCallId,
    header: "Question",
    question: boundText(question, QUESTION_TEXT_LIMIT),
    multiSelect: false,
    options: request.options.map((option, index) => ({
      label: labels[index]!,
      description: questionLabel(option),
    })),
  };
}

/**
 * The person's answer → the option the agent offered: its label as the card
 * showed it, or the option id itself (upstream answers with ids). Anything
 * else keeps the question open (undefined).
 */
export function makeAntigravityUserInputResponse(
  request: EffectAcpSchema.RequestPermissionRequest,
  answers: Readonly<Record<string, unknown>>,
): EffectAcpSchema.RequestPermissionResponse | undefined {
  if (!validQuestionOptions(request)) return undefined;
  const raw = answers[request.toolCall.toolCallId];
  const value =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string"
        ? raw[0]
        : undefined;
  if (value === undefined || value === "") return undefined;
  const exact = request.options.find((option) => option.optionId === value);
  if (exact) return { outcome: { outcome: "selected", optionId: exact.optionId } };
  const labels = questionLabels(request.options);
  const matching = request.options.filter((_, index) => labels[index] === value.trim());
  const option = matching.length === 1 ? matching[0] : undefined;
  return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined;
}

/**
 * agy names Uno Work's MCP tools "Run mcp_<server>_<tool>" (or "MCP Tool
 * <tool>" through its proxy with `ServerName` in rawInput). The uno-work tools
 * ask the person themselves, so their prompt is answered "allow once" — that
 * exact shape only, never a shell command (upstream isAntigravityT3McpRequest).
 */
const UNO_WORK_TITLE = new RegExp(
  `^Run(?:ning)? mcp_${UNO_WORK_MCP_SERVER_NAME}_[A-Za-z0-9_]+\\??$`,
);
const PROXIED_TITLE = /^MCP Tool (?<tool>[A-Za-z0-9_]+)\??$/;

export function antigravityAutoApprove(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  if (isAntigravityUserInputRequest(request)) return undefined;
  const title = request.toolCall.title?.trim() ?? "";
  const rawInput = request.toolCall.rawInput;
  const input =
    typeof rawInput === "object" && rawInput !== null && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : undefined;
  if (typeof input?.CommandLine === "string") return undefined;
  const proxied = PROXIED_TITLE.exec(title)?.groups?.tool;
  const isUnoWork =
    proxied !== undefined
      ? input?.ServerName === UNO_WORK_MCP_SERVER_NAME && input.ToolName === proxied
      : UNO_WORK_TITLE.test(title);
  if (!isUnoWork) return undefined;
  const kind = request.toolCall.kind ?? undefined;
  if (kind === "execute" || kind === "edit" || kind === "delete" || kind === "move") {
    return undefined;
  }
  return optionOfKinds(request, ["allow_once"]);
}

/** `/logout` would sign the whole computer out of Antigravity from a chat; Settings does that. */
export function antigravityRefusePrompt(text: string): string | undefined {
  return /^\/logout\s*$/i.test(text.trim())
    ? "To sign Antigravity out, use Settings → AI → Antigravity → Sign out."
    : undefined;
}

/* ------------------------------------------------------------------ *
 * Models and thinking levels
 * ------------------------------------------------------------------ */

type ConfigOption = EffectAcpSchema.SessionConfigOption;

export function antigravityModelOptions(
  configOptions: ReadonlyArray<ConfigOption>,
): ReadonlyArray<{ readonly value: string; readonly name: string }> {
  const model = configOptions.find((option) => option.id === "model");
  if (model?.type !== "select") return [];
  return model.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

/** Runtime 1.4+ reports thinking as its own option; 1.3 encoded it in the model id. */
export function antigravityThinkingConfig(
  configOptions: ReadonlyArray<ConfigOption> | null | undefined,
): Extract<ConfigOption, { readonly type: "select" }> | undefined {
  const option = configOptions?.find((candidate) => candidate.category === "thought_level");
  return option?.type === "select" ? option : undefined;
}

/**
 * Runtime 1.4 lists `gemini-3.8-flash` where 1.3 listed `gemini-3.8-flash-high`.
 * The agent still accepts the old ids, so a saved pick of one keeps working
 * (upstream legacyAntigravityFamily).
 */
export function legacyAntigravityFamily(
  configOptions: ReadonlyArray<ConfigOption>,
  model: string,
): string | undefined {
  return antigravityModelOptions(configOptions)
    .map((option) => option.value)
    .filter((family) => model.startsWith(`${family}-`))
    .toSorted((left, right) => right.length - left.length)[0];
}

export type AntigravityModelStep =
  | { readonly kind: "keep"; readonly model: string | undefined }
  | { readonly kind: "set"; readonly model: string }
  | { readonly kind: "setLegacy"; readonly model: string; readonly family: string }
  | { readonly kind: "unavailable"; readonly model: string };

/**
 * What to do for a picked model: keep the session's own for the default (a
 * resumed session keeps its model), switch to a listed one, pass an old id
 * through, or refuse an id this account no longer has (upstream
 * applyAntigravityAcpModelSelection).
 */
export function planAntigravityModel(
  configOptions: ReadonlyArray<ConfigOption>,
  picked: string | null | undefined,
): AntigravityModelStep {
  const modelConfig = configOptions.find((option) => option.id === "model");
  const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
  const model = picked?.trim();
  if (!model || model === ANTIGRAVITY_DEFAULT_MODEL || model === "default" || model === current) {
    return { kind: "keep", model: current };
  }
  const options = antigravityModelOptions(configOptions);
  if (options.length === 0) return { kind: "keep", model: current };
  if (options.some((option) => option.value === model)) return { kind: "set", model };
  const family = legacyAntigravityFamily(configOptions, model);
  if (family !== undefined && family === current) return { kind: "keep", model: current };
  if (family !== undefined) return { kind: "setLegacy", model, family };
  return { kind: "unavailable", model };
}

/** The thinking level picked in the model picker, when the session's model offers it. */
export function antigravityThinkingSelection(
  configOptions: ReadonlyArray<ConfigOption>,
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): { readonly configId: string; readonly value: string } | undefined {
  const thinking = antigravityThinkingConfig(configOptions);
  if (!thinking || !selections) return undefined;
  const picked = selections.find((selection) => selection.id === thinking.id);
  if (!picked || typeof picked.value !== "string") return undefined;
  const values = thinking.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
  if (!values.includes(picked.value) || picked.value === thinking.currentValue) return undefined;
  return { configId: thinking.id, value: picked.value };
}

/**
 * The config option writes for a picked model and thinking level. The
 * adapter applies them and asks again, so the thinking level is picked from
 * the options of the model just switched to.
 */
export function planAntigravityModelSelection(input: {
  readonly configOptions: ReadonlyArray<ConfigOption>;
  readonly model: string | undefined;
  readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
}):
  | {
      readonly ok: true;
      readonly model?: string;
      readonly writes: ReadonlyArray<{ readonly configId: string; readonly value: string }>;
    }
  | { readonly ok: false; readonly reason: string } {
  const step = planAntigravityModel(input.configOptions, input.model);
  if (step.kind === "unavailable") {
    return {
      ok: false,
      reason: `Antigravity on this computer does not offer the model "${step.model}". Pick another model.`,
    };
  }
  if (step.kind === "set") {
    return { ok: true, model: step.model, writes: [{ configId: "model", value: step.model }] };
  }
  if (step.kind === "setLegacy") {
    // A 1.3 pick ("…-high") runs as its family; the level is picked separately now.
    return { ok: true, model: step.family, writes: [{ configId: "model", value: step.family }] };
  }
  const thinking = antigravityThinkingSelection(input.configOptions, input.options);
  return {
    ok: true,
    ...(step.model !== undefined ? { model: step.model } : {}),
    writes: thinking ? [thinking] : [],
  };
}

/* ------------------------------------------------------------------ *
 * Session updates (upstream AntigravityProtocol)
 * ------------------------------------------------------------------ */

const TOOL_TEXT_LIMIT = 8_000;
const TOOL_TEXT_TRUNCATED = "[Earlier output truncated]\n\n";
const COMMAND_LINE_TRUNCATED = "\n\n[Command truncated]";
const COMMAND_LINE_FIELDS = new Set(["CommandLine", "command_line", "commandLine", "command"]);

function boundToolText(text: string, limit = TOOL_TEXT_LIMIT): string {
  return text.length <= limit ? text : `${TOOL_TEXT_TRUNCATED}${text.slice(-limit)}`;
}

function boundCommandLine(text: string, limit = TOOL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, "")}${COMMAND_LINE_TRUNCATED}`;
}

interface PayloadBudget {
  nodes: number;
  text: number;
}

function sanitizeToolValue(
  value: unknown,
  budget: PayloadBudget,
  depth: number,
  field?: string,
): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === "string") {
    if (/^data:image\//i.test(value) || budget.text <= 0) return undefined;
    const limit = Math.min(TOOL_TEXT_LIMIT, budget.text);
    const text =
      field !== undefined && COMMAND_LINE_FIELDS.has(field)
        ? boundCommandLine(value, limit)
        : boundToolText(value, limit);
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) break;
      const sanitized = sanitizeToolValue(entry, budget, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    return result;
  }
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, entry] of Object.entries(record)) {
    if (budget.nodes <= 0) break;
    if (
      (record.type === "image" && (key === "data" || key === "blob")) ||
      (key === "blob" &&
        typeof record.mimeType === "string" &&
        record.mimeType.startsWith("image/"))
    ) {
      continue;
    }
    const sanitized = sanitizeToolValue(entry, budget, depth + 1, key);
    if (sanitized !== undefined) entries.push([key, sanitized]);
  }
  return Object.fromEntries(entries);
}

/** Bounded copy of a tool payload: no inline images, long text keeps its tail. */
export function sanitizeAntigravityToolPayload(payload: unknown): unknown {
  return sanitizeToolValue(payload, { nodes: 512, text: 64_000 }, 0);
}

/** Native fields of agy's command tools → the shape the chat's command row reads. */
function nativeCommand(rawInput: unknown): { command?: string; cwd?: string } {
  if (typeof rawInput !== "object" || rawInput === null) return {};
  const input = rawInput as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };
  const command = pick("CommandLine", "command_line", "commandLine", "command");
  const cwd = pick("Cwd", "WorkingDirectory", "working_dir", "workingDir", "cwd");
  return {
    ...(command ? { command: boundCommandLine(command) } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function updateStepsEntries(rawInput: unknown) {
  if (typeof rawInput !== "object" || rawInput === null) return undefined;
  const steps = (rawInput as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return undefined;
  return steps.flatMap((step) => {
    if (typeof step !== "object" || step === null) return [];
    const { title, status } = step as { title?: unknown; status?: unknown };
    if (typeof title !== "string") return [];
    const mapped: "completed" | "in_progress" | "pending" =
      status === "done" || status === "completed"
        ? "completed"
        : status === "in_progress"
          ? "in_progress"
          : "pending";
    return [{ content: title, priority: "medium" as const, status: mapped }];
  });
}

const SUBAGENT_TITLES = new Set([
  "Running start_subagent",
  "Run start_subagent?",
  "Running invoke_subagent",
  "Run invoke_subagent?",
  "Run invoke_subagent",
]);

/** agy reports subagents as ordinary tools without child ids (upstream classifyAntigravitySubagentToolCall). */
export function isAntigravitySubagentTitle(title: string | null | undefined): boolean {
  return title !== undefined && title !== null && SUBAGENT_TITLES.has(title);
}

type ToolUpdate = Extract<
  EffectAcpSchema.SessionUpdate,
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

/**
 * Per-session rewrite of agy's `session/update`s, before the shared parser:
 *   - tool payloads bounded (agy sends whole files and command output);
 *   - its `update_steps` checklist, sent only as tool calls, becomes the
 *     chat's plan; the call itself is dropped;
 *   - a command's native `CommandLine` / `Cwd` fill the ACP fields the
 *     command row shows;
 *   - a subagent call is titled as one ("Subagent: <role>").
 */
export function makeAntigravitySessionUpdateTransform() {
  const updateStepsCalls = new Set<string>();
  return (
    notification: EffectAcpSchema.SessionNotification,
  ): EffectAcpSchema.SessionNotification | undefined => {
    const update = notification.update;
    if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
      return notification;
    }
    const key = `${notification.sessionId}\u0000${update.toolCallId}`;
    if (
      update.title === "Run update_steps" &&
      (update.kind === undefined || update.kind === null || update.kind === "other")
    ) {
      updateStepsCalls.add(key);
    }
    if (updateStepsCalls.has(key)) {
      if (update.status === "completed" || update.status === "failed") {
        updateStepsCalls.delete(key);
      }
      const entries = updateStepsEntries(update.rawInput);
      return entries === undefined
        ? undefined
        : { ...notification, update: { sessionUpdate: "plan", entries } };
    }
    return { ...notification, update: normalizeToolUpdate(update) };
  };
}

function normalizeToolUpdate(update: ToolUpdate): ToolUpdate {
  const budget = { nodes: 512, text: 32_000 };
  const content = update.content?.flatMap((entry) => {
    const sanitized = sanitizeToolValue(entry, budget, 0);
    return typeof sanitized === "object" && sanitized !== null
      ? [sanitized as NonNullable<ToolUpdate["content"]>[number]]
      : [];
  });
  const native = nativeCommand(update.rawInput);
  const subagent = isAntigravitySubagentTitle(update.title)
    ? subagentTitle(update.rawInput)
    : undefined;
  const rawInput =
    update.rawInput === undefined ? undefined : sanitizeAntigravityToolPayload(update.rawInput);
  return {
    ...update,
    ...(typeof update.title === "string" ? { title: subagent ?? boundToolText(update.title) } : {}),
    ...(native.command && (update.kind === "execute" || update.kind === undefined)
      ? { kind: "execute" as const }
      : {}),
    ...(rawInput !== undefined
      ? {
          rawInput:
            native.command && typeof rawInput === "object" && rawInput !== null
              ? {
                  ...(rawInput as Record<string, unknown>),
                  command: native.command,
                  ...(native.cwd ? { cwd: native.cwd } : {}),
                }
              : rawInput,
        }
      : {}),
    ...(update.rawOutput !== undefined
      ? { rawOutput: sanitizeAntigravityToolPayload(update.rawOutput) }
      : {}),
    ...(update.content !== undefined ? { content: content ?? [] } : {}),
  } as ToolUpdate;
}

function subagentTitle(rawInput: unknown): string {
  if (typeof rawInput === "object" && rawInput !== null) {
    const input = rawInput as Record<string, unknown>;
    for (const key of ["Role", "role", "Name", "name", "AgentName", "agent"]) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) {
        return `Subagent: ${boundToolText(value.trim(), 120)}`;
      }
    }
  }
  return "Subagent";
}

/** A tool call the turn may end with still open: a running command or a scheduled wake (upstream). */
export function antigravityToolOutlivesPrompt(toolCall: AcpToolCallState): boolean {
  if (toolCall.title === "Run schedule" || toolCall.title === "Running schedule") return true;
  const input = toolCall.data.rawInput;
  return (
    toolCall.kind === "execute" &&
    !(
      typeof input === "object" &&
      input !== null &&
      (input as { IsDaemon?: unknown }).IsDaemon === true
    )
  );
}
