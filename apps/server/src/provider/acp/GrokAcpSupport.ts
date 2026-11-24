/**
 * GrokAcpSupport — what Uno Work knows about xAI's Grok CLI ("Grok Build",
 * npm `@xai-official/grok`, `grok agent stdio`), checked live against 1.0.92
 * on 23.11.2026 and against upstream T3 Code's provider-grok:
 *
 *   - `initialize` advertises `loadSession`, image prompts, http/sse MCP and
 *     session list/resume/close; its only auth method is `grok.com`, but
 *     `authenticate` also takes `cached_token` (the stored sign-in) and
 *     `xai.api_key` (`XAI_API_KEY`). `session/new` without `authenticate`
 *     fails "Authentication required".
 *   - `authenticate cached_token` with nobody signed in never answers (no
 *     reply in 25 s, nothing on stdout or stderr), so a chat refuses to start
 *     without a sign-in (`grokPreflight`) and the handshake has a deadline.
 *   - `session/new` has no `modes`: the model (grok-4.6, grok-4.5) and the
 *     reasoning effort are config options. Plan is Grok's own tool
 *     (enter/exit_plan_mode), so Uno Work's Plan toggle is hidden.
 *   - The sign-in lives in `~/.grok/auth.json` (`$GROK_HOME/auth.json`),
 *     written by `grok login` (device code on a computer without a browser:
 *     `grok login --device-auth`) and removed by `grok logout`.
 *   - Grok's own permission modes (`auto`, `bypassPermissions`, …) and a
 *     person's `~/.grok/config.toml` `permission_mode` could answer prompts
 *     without us; the argv `--permission-mode default` overrides them, so
 *     every edit and command asks and Uno Work answers by the chat's mode.
 *     Its slash commands `/always-approve` ("skip all permission prompts")
 *     and `/yolo` run inside `session/prompt` (checked live 24.11: answered
 *     at once, no model call), so Uno Work never sends them
 *     (`grokRefusePrompt`).
 *
 * @module GrokAcpSupport
 */
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import type * as EffectAcpSchema from "effect-acp/schema";

import { UNO_WORK_MCP_SERVER_NAME } from "../../unoWork/constants.ts";
import { optionOfKinds } from "./AcpAdapterSupport.ts";

export const GROK_DRIVER_KIND = "grok";
export const GROK_DISPLAY_NAME = "Grok";
export const GROK_NPM_PACKAGE = "@xai-official/grok";
/** `default`: Grok asks for every edit and command; see the module comment. */
export const GROK_ACP_ARGS: ReadonlyArray<string> = [
  "--permission-mode",
  "default",
  "agent",
  "stdio",
];
export const GROK_DEFAULT_MODEL = "grok-4.6";

/** The variable Grok CLI reads an xAI API key from (console.x.ai). */
export const GROK_API_KEY_ENV = "XAI_API_KEY";
export const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
export const GROK_AUTH_METHOD_SIGN_IN = "cached_token";

/**
 * Environment every Grok process gets from Uno Work: no self-update in the
 * middle of a chat (Settings → AI → Update does that).
 */
export const GROK_PROCESS_ENV: Readonly<Record<string, string>> = {
  GROK_DISABLE_AUTOUPDATER: "1",
};

/**
 * `initialize` `_meta`: as a "generic" client Grok silently denies what its
 * Auto reviewer refuses; as an "extension" it asks, without remembering
 * command grants (upstream T3 Code).
 */
export const GROK_INITIALIZE_META: Readonly<Record<string, unknown>> = { clientType: "extension" };
/** `session/cancel` `_meta`: Grok stops the turn as on Ctrl+C. */
export const GROK_CANCEL_META: Readonly<Record<string, unknown>> = { cancelTrigger: "ctrl_c" };

/** initialize → session/new; MCP servers connect in it. */
export const GROK_START_TIMEOUT_MS = 120_000;
/** Grok can leave `session/load` unanswered after the replay (upstream T3 Code). */
export const GROK_SESSION_LOAD_TIMEOUT_MS = 30_000;

/** Where the CLI keeps its settings and sign-in. */
export function grokHomeDir(env: NodeJS.ProcessEnv, home = os.homedir()): string {
  const custom = env.GROK_HOME?.trim();
  return custom || nodePath.join(home, ".grok");
}

export function grokAuthFile(env: NodeJS.ProcessEnv): string {
  return nodePath.join(grokHomeDir(env), "auth.json");
}

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

export type GrokAuthType = "xai-account" | "xai-api-key";

export interface GrokAuthState {
  readonly status: "authenticated" | "unauthenticated";
  readonly type?: GrokAuthType;
  /** "xAI account" / "xAI API key". */
  readonly label?: string;
  readonly message?: string;
}

/** Whether `auth.json` holds a sign-in: a JSON object with at least one entry. */
export function hasGrokSignIn(authJson: string | undefined): boolean {
  if (!authJson?.trim()) return false;
  try {
    const parsed: unknown = JSON.parse(authJson);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Object.values(parsed).some((entry) => entry !== null && entry !== undefined && entry !== "")
    );
  } catch {
    // Unreadable as JSON but not empty: let the CLI judge it.
    return true;
  }
}

/**
 * Pure: the sign-in a Uno Work chat will use. The API key wins when it is
 * set: the chat authenticates with it (`xai.api_key`, answered at once),
 * as upstream T3 Code does; else the stored xAI sign-in.
 */
export function describeGrokAuth(
  env: NodeJS.ProcessEnv,
  authJson: string | undefined,
): GrokAuthState {
  if (env[GROK_API_KEY_ENV]?.trim()) {
    return { status: "authenticated", type: "xai-api-key", label: "xAI API key" };
  }
  if (hasGrokSignIn(authJson)) {
    return { status: "authenticated", type: "xai-account", label: "xAI account" };
  }
  return {
    status: "unauthenticated",
    message: "Sign in with your xAI account or add an xAI API key.",
  };
}

async function readText(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

export async function probeGrokAuth(env: NodeJS.ProcessEnv): Promise<GrokAuthState> {
  return describeGrokAuth(env, await readText(grokAuthFile(env)));
}

/**
 * The ACP `authenticate` method for a session (see describeGrokAuth).
 * Without a sign-in there is nothing to send, and `grokPreflight` refuses
 * the start.
 */
export async function grokAuthMethodFor(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const auth = await probeGrokAuth(env);
  if (auth.type === "xai-account") return GROK_AUTH_METHOD_SIGN_IN;
  if (auth.type === "xai-api-key") return GROK_AUTH_METHOD_API_KEY;
  return undefined;
}

export const GROK_SIGN_IN_HINT =
  "Sign in on this computer: Settings → AI → Grok → Sign in (xAI account or an xAI API key).";

/** Refuse a chat whose Grok would wait forever on a sign-in (see the module comment). */
export async function grokPreflight(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const auth = await probeGrokAuth(env);
  return auth.status === "unauthenticated"
    ? `Grok is not signed in on this computer. ${GROK_SIGN_IN_HINT}`
    : undefined;
}

/* ------------------------------------------------------------------ *
 * Permissions
 * ------------------------------------------------------------------ */

/** Grok slash commands that turn its permission prompts off for the session. */
const PERMISSION_SKIPPING_COMMAND = /^\/(always-approve|yolo)(\s|$)/i;

/**
 * A message Grok must not get: `/always-approve` or `/yolo` at its start
 * would let Grok edit and run commands without asking, past the chat's mode
 * and a restricted chat's rules. Returns the reason shown in the chat.
 */
export function grokRefusePrompt(text: string): string | undefined {
  const match = PERMISSION_SKIPPING_COMMAND.exec(text.trimStart());
  if (!match) return undefined;
  return `Grok's /${match[1]!.toLowerCase()} is turned off in Uno Work: the chat's mode decides what Grok may do without asking. To let it work without asking, switch the chat to Full access.`;
}

/**
 * Grok names MCP tools "<server>__<tool>" (docs: 07-mcp-servers,
 * 22-permissions-and-safety). The uno-work tools ask the person themselves
 * (the reason Claude, OpenCode and Gemini pre-approve them), so their prompt
 * is answered "allow once" — only that exact shape, and never a shell or
 * file call.
 */
const UNO_WORK_TOOL_TITLE = new RegExp(`^${UNO_WORK_MCP_SERVER_NAME}__[A-Za-z0-9_-]+$`);
const NEVER_AUTO_KINDS = new Set(["execute", "edit", "delete", "move"]);

export function grokAutoApprove(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const title = request.toolCall.title?.trim() ?? "";
  if (!UNO_WORK_TOOL_TITLE.test(title)) return undefined;
  const kind = request.toolCall.kind ?? undefined;
  if (kind !== undefined && NEVER_AUTO_KINDS.has(kind)) return undefined;
  return optionOfKinds(request, ["allow_once"]);
}
