/**
 * GeminiAcpSupport — what Uno Work knows about Google's Gemini CLI
 * (`@google/gemini-cli`, `gemini --acp`), checked live against 0.70.0 on
 * 20.11.2026:
 *
 *   - `initialize` advertises `loadSession`, image prompts, http/sse MCP and
 *     the auth methods `oauth-personal`, `gemini-api-key`, `vertex-ai`,
 *     `gateway`; `session/new` answers `modes` (default / autoEdit / yolo /
 *     plan) and the unstable `models` state (`auto` + the Gemini lineup).
 *     There are no config options: modes go through `session/set_mode`,
 *     models through `session/set_model`.
 *   - The sign-in lives in `~/.gemini` (`$GEMINI_CLI_HOME/.gemini`):
 *     `settings.json` `security.auth.selectedType` says which one the CLI
 *     uses; a Google sign-in leaves `google_accounts.json` (`active`: the
 *     email) and the tokens in the OS keychain or, without one (a cloud
 *     computer), `gemini-credentials.json` (older CLIs: `oauth_creds.json`).
 *     With no `selectedType` the CLI picks from the environment
 *     (`GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`, …).
 *   - A Google sign-in the CLI can't refresh is a trap: on start it prints a
 *     sign-in URL to stdout — the ACP channel — and reads the code from
 *     stdin, i.e. it eats our `initialize` and the session never starts. So
 *     a chat refuses to start when that sign-in is missing (`geminiPreflight`)
 *     and the handshake has a deadline.
 *
 * @module GeminiAcpSupport
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import { UNO_WORK_MCP_SERVER_NAME } from "../../unoWork/constants.ts";
import { optionOfKinds } from "./AcpAdapterSupport.ts";

export const GEMINI_DRIVER_KIND = "gemini";
export const GEMINI_DISPLAY_NAME = "Gemini CLI";
export const GEMINI_NPM_PACKAGE = "@google/gemini-cli";
export const GEMINI_ACP_ARGS: ReadonlyArray<string> = ["--acp"];
/** Gemini CLI's own router: Pro for hard turns, Flash for the rest. */
export const GEMINI_AUTO_MODEL = "auto";

/**
 * Environment every Gemini process gets from Uno Work:
 *   - `NO_BROWSER`: a chat never opens a browser tab for a sign-in (that is
 *     Settings → AI → Sign in, see HarnessSetupService);
 *   - `GEMINI_CLI_NO_RELAUNCH`: the CLI otherwise restarts itself as a second
 *     node process with a bigger heap — twice the memory per chat on a 2 GB
 *     computer.
 */
export const GEMINI_PROCESS_ENV: Readonly<Record<string, string>> = {
  NO_BROWSER: "true",
  GEMINI_CLI_NO_RELAUNCH: "true",
};

/** How long `initialize` → `session/new` may take (MCP servers connect in it). */
export const GEMINI_START_TIMEOUT_MS = 120_000;

/** Where the CLI keeps its settings and sign-in. */
export function geminiConfigDir(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  const base = env.GEMINI_CLI_HOME?.trim() || home;
  return nodePath.join(base, ".gemini");
}

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

export type GeminiAuthType =
  | "oauth-personal"
  | "gemini-api-key"
  | "vertex-ai"
  | "gateway"
  | "compute-default-credentials";

export interface GeminiAuthState {
  readonly status: "authenticated" | "unauthenticated" | "unknown";
  readonly type?: GeminiAuthType;
  /** "Google account", "Gemini API key", "Vertex AI", … */
  readonly label?: string;
  readonly email?: string;
  /** Why it isn't signed in, for the Settings row. */
  readonly message?: string;
}

const AUTH_LABELS: Readonly<Record<GeminiAuthType, string>> = {
  "oauth-personal": "Google account",
  "gemini-api-key": "Gemini API key",
  "vertex-ai": "Vertex AI",
  gateway: "AI API gateway",
  "compute-default-credentials": "Google Cloud credentials",
};

const KNOWN_AUTH_TYPES = new Set<string>(Object.keys(AUTH_LABELS));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** settings.json allows comments (the CLI strips them); enough of that for our two keys. */
export function parseJsonWithComments(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"\\])\/\/.*$/gm, "$1")
      .replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(stripped);
    } catch {
      return undefined;
    }
  }
}

/** `security.auth.selectedType`, or the pre-0.3 top-level `selectedAuthType`. */
export function selectedAuthTypeOf(settings: unknown): string | undefined {
  if (!isRecord(settings)) return undefined;
  const security = isRecord(settings.security) ? settings.security : undefined;
  const auth = security && isRecord(security.auth) ? security.auth : undefined;
  const selected = auth?.selectedType ?? settings.selectedAuthType;
  return typeof selected === "string" && selected.trim() ? selected.trim() : undefined;
}

/** The CLI's own choice when settings name none (its `getAuthTypeFromEnv`). */
export function authTypeFromEnv(env: NodeJS.ProcessEnv): GeminiAuthType | undefined {
  if (env.GOOGLE_GENAI_USE_GCA === "true") return "oauth-personal";
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") return "vertex-ai";
  if (env.GOOGLE_GEMINI_BASE_URL?.trim()) return "gateway";
  if (env.GEMINI_API_KEY?.trim()) return "gemini-api-key";
  if (env.CLOUD_SHELL === "true" || env.GEMINI_CLI_USE_COMPUTE_ADC === "true") {
    return "compute-default-credentials";
  }
  return undefined;
}

export interface GeminiAuthFiles {
  /** settings.json, parsed (undefined: missing or unreadable). */
  readonly settings: unknown;
  /** google_accounts.json `active`. */
  readonly activeAccount: string | undefined;
  /** A token file on disk (keychain-less machines, older CLIs). */
  readonly hasTokenFile: boolean;
}

/** Pure: the sign-in the CLI will use, from its files and the environment. */
export function describeGeminiAuth(
  env: NodeJS.ProcessEnv,
  files: GeminiAuthFiles,
): GeminiAuthState {
  const selected = selectedAuthTypeOf(files.settings);
  const type = (selected && KNOWN_AUTH_TYPES.has(selected) ? selected : undefined) as
    | GeminiAuthType
    | undefined;
  const effective = type ?? authTypeFromEnv(env);
  if (!effective) {
    return {
      status: "unauthenticated",
      message: "Sign in with Google or add a Gemini API key.",
    };
  }
  const label = AUTH_LABELS[effective];
  switch (effective) {
    case "oauth-personal": {
      if (files.activeAccount || files.hasTokenFile) {
        return {
          status: "authenticated",
          type: effective,
          label,
          ...(files.activeAccount ? { email: files.activeAccount } : {}),
        };
      }
      return {
        status: "unauthenticated",
        type: effective,
        label,
        message: "The Google sign-in of Gemini CLI is gone. Sign in again.",
      };
    }
    case "gemini-api-key":
      return env.GEMINI_API_KEY?.trim()
        ? { status: "authenticated", type: effective, label }
        : {
            status: "unauthenticated",
            type: effective,
            label,
            message: "Gemini CLI is set to an API key, and GEMINI_API_KEY is not set.",
          };
    case "vertex-ai": {
      const ready =
        Boolean(env.GOOGLE_API_KEY?.trim()) ||
        (Boolean(env.GOOGLE_CLOUD_PROJECT?.trim()) && Boolean(env.GOOGLE_CLOUD_LOCATION?.trim()));
      return ready
        ? { status: "authenticated", type: effective, label }
        : {
            status: "unauthenticated",
            type: effective,
            label,
            message:
              "Vertex AI needs GOOGLE_API_KEY, or GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.",
          };
    }
    default:
      // A gateway or Cloud credentials: nothing on disk to look at.
      return { status: "unknown", type: effective, label };
  }
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

async function isNonEmptyFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export async function readGeminiAuthFiles(env: NodeJS.ProcessEnv): Promise<GeminiAuthFiles> {
  const dir = geminiConfigDir(env);
  const [settingsText, accountsText, credentials, legacyCredentials] = await Promise.all([
    readText(nodePath.join(dir, "settings.json")),
    readText(nodePath.join(dir, "google_accounts.json")),
    isNonEmptyFile(nodePath.join(dir, "gemini-credentials.json")),
    isNonEmptyFile(nodePath.join(dir, "oauth_creds.json")),
  ]);
  const accounts = accountsText ? parseJsonWithComments(accountsText) : undefined;
  const active = isRecord(accounts) && typeof accounts.active === "string" ? accounts.active : "";
  return {
    settings: settingsText ? parseJsonWithComments(settingsText) : undefined,
    activeAccount: active.trim() || undefined,
    hasTokenFile: credentials || legacyCredentials,
  };
}

export async function probeGeminiAuth(env: NodeJS.ProcessEnv): Promise<GeminiAuthState> {
  return describeGeminiAuth(env, await readGeminiAuthFiles(env));
}

export const GEMINI_SIGN_IN_HINT =
  "Sign in on this computer: Settings → AI → Gemini CLI → Sign in (Google account or a Gemini API key).";

/**
 * Refuse a chat whose Gemini would sit on a sign-in prompt (see the module
 * comment). Other gaps (no key at all) make the CLI fail fast with its own
 * words, which the chat shows.
 */
export async function geminiPreflight(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const auth = await probeGeminiAuth(env);
  if (auth.status === "unauthenticated" && auth.type === "oauth-personal") {
    return `Gemini CLI is not signed in to Google on this computer. ${GEMINI_SIGN_IN_HINT}`;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Sign-in files (Settings → AI → Gemini CLI)
 * ------------------------------------------------------------------ */

/** The variable Gemini CLI reads its API key from. */
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";
export const GEMINI_GOOGLE_AUTH_TYPE: GeminiAuthType = "oauth-personal";
export const GEMINI_API_KEY_AUTH_TYPE: GeminiAuthType = "gemini-api-key";

async function readSettingsForEdit(file: string): Promise<Record<string, unknown>> {
  const text = await readText(file);
  if (text === undefined || text.trim().length === 0) return {};
  const parsed = parseJsonWithComments(text);
  if (!isRecord(parsed)) {
    throw new Error(
      `${file} is not valid JSON, so Uno Work can't change the Gemini CLI sign-in there. Fix or remove the file and try again.`,
    );
  }
  return parsed;
}

/** `security.auth.selectedType` as the CLI will read it. */
export async function readGeminiSelectedAuthType(
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const text = await readText(nodePath.join(geminiConfigDir(env), "settings.json"));
  return text ? selectedAuthTypeOf(parseJsonWithComments(text)) : undefined;
}

/**
 * Tell Gemini CLI which sign-in to use (what its own `/auth` dialog saves);
 * `undefined` removes the choice, so the CLI goes by the environment again.
 * Everything else in settings.json stays (comments in it do not).
 */
export async function writeGeminiSelectedAuthType(
  env: NodeJS.ProcessEnv,
  type: string | undefined,
): Promise<void> {
  const dir = geminiConfigDir(env);
  const file = nodePath.join(dir, "settings.json");
  const settings = await readSettingsForEdit(file);
  if (selectedAuthTypeOf(settings) === type && settings.selectedAuthType === undefined) return;
  const security = isRecord(settings.security) ? { ...settings.security } : {};
  const auth = isRecord(security.auth) ? { ...security.auth } : {};
  if (type) auth.selectedType = type;
  else delete auth.selectedType;
  security.auth = auth;
  const next: Record<string, unknown> = { ...settings, security };
  delete next.selectedAuthType;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

/** The Google account Gemini CLI is signed in to here, if any. */
export async function geminiGoogleAccount(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const files = await readGeminiAuthFiles(env);
  if (files.activeAccount) return files.activeAccount;
  return files.hasTokenFile ? "a Google account" : undefined;
}

/**
 * Forget the Google sign-in the way the CLI's own sign-out does: the token
 * files go, `google_accounts.json` keeps the address under `old`. On a Mac
 * the tokens are a Keychain item, which stays (unused once nothing selects
 * the Google sign-in).
 */
export async function clearGeminiGoogleSignIn(env: NodeJS.ProcessEnv): Promise<boolean> {
  const dir = geminiConfigDir(env);
  let cleared = false;
  for (const name of ["gemini-credentials.json", "oauth_creds.json"]) {
    const file = nodePath.join(dir, name);
    if (await isNonEmptyFile(file)) cleared = true;
    await rm(file, { force: true });
  }
  const accountsFile = nodePath.join(dir, "google_accounts.json");
  const text = await readText(accountsFile);
  const accounts = text ? parseJsonWithComments(text) : undefined;
  if (isRecord(accounts) && typeof accounts.active === "string" && accounts.active) {
    const old = Array.isArray(accounts.old)
      ? accounts.old.filter((entry) => entry !== accounts.active)
      : [];
    await writeFile(
      accountsFile,
      `${JSON.stringify({ ...accounts, active: null, old: [...old, accounts.active] }, null, 2)}\n`,
      { mode: 0o600 },
    );
    cleared = true;
  }
  return cleared;
}

/* ------------------------------------------------------------------ *
 * Modes and permissions
 * ------------------------------------------------------------------ */

export const GEMINI_MODE_DEFAULT = "default";
export const GEMINI_MODE_PLAN = "plan";

/**
 * Gemini's own modes skip its permission prompts (`autoEdit`, `yolo`), and a
 * person's `~/.gemini/settings.json` may start sessions in one of them. Uno
 * Work answers every prompt itself by the chat's mode (Ask / Auto-edit /
 * Full access, narrowed for outside text and assistants), so a session always
 * runs in `default` — every edit and command comes to us — or in `plan`
 * (read-only) for Plan.
 */
export function geminiModeFor(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modeState: { readonly availableModeIds: ReadonlyArray<string> };
}): string | undefined {
  const wanted = input.interactionMode === "plan" ? GEMINI_MODE_PLAN : GEMINI_MODE_DEFAULT;
  return input.modeState.availableModeIds.includes(wanted) ? wanted : undefined;
}

/**
 * Gemini CLI 0.70 tells its own UI about a mode switch with an agent text
 * chunk, `[MODE_UPDATE] plan`, at the start of the next prompt (seen live
 * 20.11.2026). Not words for the person: dropped.
 */
const GEMINI_MODE_UPDATE_CHUNK = /^\s*\[MODE_UPDATE\] [\w-]+\s*$/;

export function isGeminiControlText(text: string): boolean {
  return GEMINI_MODE_UPDATE_CHUNK.test(text);
}

/**
 * Gemini CLI titles MCP tool calls "<tool> (<server> MCP Server)". The
 * uno-work tools ask the person themselves (the same reason Claude and
 * OpenCode pre-approve them), so their prompt is answered "allow once".
 * Only that exact shape — one tool name, no command — and never a shell or
 * file call, so a command that merely ends in those words still asks.
 */
const UNO_WORK_TOOL_TITLE = new RegExp(`^[\\w.-]+ \\(${UNO_WORK_MCP_SERVER_NAME} MCP Server\\)$`);
const NEVER_AUTO_KINDS = new Set(["execute", "edit", "delete", "move"]);

export function geminiAutoApprove(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const title = request.toolCall.title?.trim() ?? "";
  if (!UNO_WORK_TOOL_TITLE.test(title)) return undefined;
  const kind = request.toolCall.kind ?? undefined;
  if (kind !== undefined && NEVER_AUTO_KINDS.has(kind)) return undefined;
  return optionOfKinds(request, ["allow_once"]);
}
