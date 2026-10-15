/**
 * The person's own subscriptions as the Uno assistant can run on them
 * (Misha 14.10: "choose what powers it — Uno AI or your subscription").
 *
 * - Claude — Nous' official Hermes plugin `claude-subscription-directsdk`:
 *   every turn runs the official, unmodified Claude Code CLI signed in on
 *   this computer (the same sign-in Uno Work shows under Settings → AI →
 *   Agents); Anthropic counts it against the plan's Agent SDK allowance.
 *   Needs Hermes ≥ 0.21.4 — which only Hermes' own installer delivers.
 * - ChatGPT — Hermes' built-in `openai-codex` provider with the assistant's
 *   OWN sign-in (`hermes auth add openai-codex`, device code). Not the Codex
 *   CLI's tokens: ChatGPT refresh tokens are single-use, so sharing them would
 *   sign one of the two out on the next refresh. Works on Hermes 0.19.
 *
 * Both sign-ins live in the shared Hermes home (`<stateDir>/hermes-home-
 * hermes`); each chat's own home links to them (hermesThreadHomeLinks).
 *
 * @module manager/assistantSubscriptions
 */
import {
  HERMES_CLAUDE_PLUGIN_MIN_VERSION,
  type ServerProvider,
  type SubscriptionLlmStatus,
} from "@t3tools/contracts";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import { HERMES_CLAUDE_PLUGIN_DIR } from "../provider/acp/HermesAcpSupport.ts";

/** The shared Hermes home of an instance — the parent of its chats' homes. */
export function hermesSharedHome(stateDir: string, instanceId: string): string {
  return nodePath.join(stateDir, `hermes-home-${instanceId}`);
}

function parseVersion(value: string): ReadonlyArray<number> | null {
  return (
    /^(\d+)\.(\d+)\.(\d+)/
      .exec(value.trim())
      ?.slice(1)
      .map((part) => Number.parseInt(part, 10)) ?? null
  );
}

/** "0.22.0+2217.g5575a08" ≥ "0.21.4"? Unknown versions are not. */
export function hermesVersionAtLeast(version: string | null | undefined, min: string): boolean {
  if (!version) return false;
  const have = parseVersion(version);
  const want = parseVersion(min);
  if (have === null || want === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (have[index]! !== want[index]!) return have[index]! > want[index]!;
  }
  return true;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** Hermes' output without its colours. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * The page and code `hermes auth add openai-codex` prints (checked on 0.19,
 * stdout to a pipe, 14.10):
 *
 *   1. Open this URL in your browser:
 *      https://auth.openai.com/codex/device
 *   2. Enter this code:
 *      X518-DCRUM
 */
export function parseDeviceSignIn(output: string): {
  readonly url: string | null;
  readonly code: string | null;
} {
  const text = stripAnsi(output);
  const url = /(https:\/\/auth\.openai\.com\/\S+)/.exec(text)?.[1] ?? null;
  const code = /Enter this code:\s*\n?\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})/i.exec(text)?.[1] ?? null;
  return { url, code };
}

interface ChatgptSignIn {
  readonly signedIn: boolean;
  readonly plan: string | null;
  readonly account: string | null;
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function claim(claims: Record<string, unknown> | null, scope: string, key: string): string | null {
  const group = claims?.[scope];
  if (typeof group !== "object" || group === null) return null;
  const value = (group as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const PLAN_NAMES: Readonly<Record<string, string>> = {
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Team",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
  free: "ChatGPT Free",
};

/**
 * Whether the assistant's ChatGPT sign-in is there: Hermes keeps it in
 * `auth.json` — the singleton (`providers.openai-codex.tokens`) or, after
 * `hermes auth add`, an entry of `credential_pool.openai-codex`. Nothing of
 * the token leaves this function but the plan and the email its claims name.
 */
export function chatgptSignInFromAuthStore(raw: string | null): ChatgptSignIn {
  const none: ChatgptSignIn = { signedIn: false, plan: null, account: null };
  if (raw === null) return none;
  let store: unknown;
  try {
    store = JSON.parse(raw);
  } catch {
    return none;
  }
  if (typeof store !== "object" || store === null) return none;
  const record = store as Record<string, unknown>;
  const tokens: string[] = [];
  const singleton = (record.providers as Record<string, unknown> | undefined)?.["openai-codex"];
  const singletonToken = (singleton as { tokens?: { access_token?: unknown } } | undefined)?.tokens
    ?.access_token;
  if (typeof singletonToken === "string" && singletonToken.length > 0) tokens.push(singletonToken);
  const pool = (record.credential_pool as Record<string, unknown> | undefined)?.["openai-codex"];
  if (Array.isArray(pool)) {
    for (const entry of pool) {
      const token = (entry as { access_token?: unknown } | null)?.access_token;
      if (typeof token === "string" && token.length > 0) tokens.push(token);
    }
  }
  const token = tokens[0];
  if (token === undefined) return none;
  const claims = jwtClaims(token);
  const planType = claim(claims, "https://api.openai.com/auth", "chatgpt_plan_type");
  return {
    signedIn: true,
    plan: planType === null ? null : (PLAN_NAMES[planType.toLowerCase()] ?? `ChatGPT ${planType}`),
    account: claim(claims, "https://api.openai.com/profile", "email"),
  };
}

export async function readChatgptSignIn(sharedHome: string): Promise<ChatgptSignIn> {
  const raw = await fs.readFile(nodePath.join(sharedHome, "auth.json"), "utf8").catch(() => null);
  return chatgptSignInFromAuthStore(raw);
}

export async function claudePluginInstalled(sharedHome: string): Promise<boolean> {
  return fs
    .access(nodePath.join(sharedHome, "plugins", HERMES_CLAUDE_PLUGIN_DIR, "plugin.yaml"))
    .then(
      () => true,
      () => false,
    );
}

/**
 * Claude Code signed in to a Claude PLAN on this computer, as its probe saw
 * it (ClaudeProvider): `auth.type` is the plan ("max", "pro"…). Claude Code
 * on Uno AI (`unoAi`), on an API key (`apiKey`), or a bare "authenticated"
 * with no plan behind it is not a subscription — the plugin would refuse or
 * fail on all three.
 */
export function claudeSignInFromProviders(providers: ReadonlyArray<ServerProvider>): {
  readonly signedIn: boolean;
  readonly plan: string | null;
  readonly account: string | null;
} {
  const claude = providers.find((provider) => provider.driver === "claudeAgent");
  const auth = claude?.auth;
  if (
    !claude?.installed ||
    auth?.status !== "authenticated" ||
    auth.type === undefined ||
    auth.type === "unoAi" ||
    auth.type === "apiKey"
  ) {
    return { signedIn: false, plan: null, account: null };
  }
  return {
    signedIn: true,
    plan: auth.label?.replace(/ Subscription$/, "") ?? null,
    account: auth.email ?? null,
  };
}

/**
 * What the engine panel shows for each subscription (contracts:
 * SubscriptionLlmStatus). Hermes is never the person's business (Misha
 * 15.10): an older Hermes is updated on the first pick of the Claude plan,
 * so it only shows when that can't happen here or just failed.
 */
export function subscriptionStatuses(input: {
  /** Hermes' version on this computer; null when not installed / not probed. */
  readonly hermesVersion: string | null;
  /** This computer can bring Hermes up to date by itself (not Windows). */
  readonly hermesUpdatable: boolean;
  /** The last such update failed, and why; null otherwise. */
  readonly hermesUpdateError: string | null;
  readonly claude: {
    readonly signedIn: boolean;
    readonly plan: string | null;
    readonly account: string | null;
  };
  readonly chatgpt: ChatgptSignIn;
}): ReadonlyArray<SubscriptionLlmStatus> {
  const claudeHermesOk = hermesVersionAtLeast(
    input.hermesVersion,
    HERMES_CLAUDE_PLUGIN_MIN_VERSION,
  );
  const claudeBase = {
    provider: "claude" as const,
    plan: input.claude.signedIn ? input.claude.plan : null,
    account: input.claude.signedIn ? input.claude.account : null,
    signIn: "harness" as const,
  };
  const claude: SubscriptionLlmStatus =
    !claudeHermesOk && !input.hermesUpdatable
      ? {
          ...claudeBase,
          state: "unavailable",
          message: "Not available on this computer yet.",
        }
      : !claudeHermesOk && input.hermesUpdateError !== null
        ? {
            ...claudeBase,
            state: input.claude.signedIn ? "ready" : "sign-in",
            message: "Couldn't set it up on this computer last time. Pick it to try again.",
          }
        : input.claude.signedIn
          ? { ...claudeBase, state: "ready", message: null }
          : {
              ...claudeBase,
              state: "sign-in",
              message: "Sign in to Claude on this computer — Uno uses that sign-in.",
            };
  const chatgpt: SubscriptionLlmStatus = input.chatgpt.signedIn
    ? {
        provider: "chatgpt",
        state: "ready",
        plan: input.chatgpt.plan,
        account: input.chatgpt.account,
        signIn: "assistant",
        message: null,
      }
    : {
        provider: "chatgpt",
        state: "sign-in",
        plan: null,
        account: null,
        signIn: "assistant",
        message: "Sign in to ChatGPT for Uno — a link and a code, about a minute.",
      };
  return [claude, chatgpt];
}

/** Environment of a Hermes command run on the shared home (sign-in, plugin install). */
export function hermesCommandEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly sharedHome: string;
}): NodeJS.ProcessEnv {
  const keep = [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
    "UV_NATIVE_TLS",
    "UV_SYSTEM_CERTS",
  ];
  const next: NodeJS.ProcessEnv = {};
  for (const name of keep) {
    const value = input.env[name];
    if (value !== undefined) next[name] = value;
  }
  next.HERMES_HOME = input.sharedHome;
  // No colours in what we parse; no prompts.
  next.NO_COLOR = "1";
  // Python buffers a piped stdout: without this the page and the code of a
  // sign-in arrive only when Hermes exits (seen live 14.10).
  next.PYTHONUNBUFFERED = "1";
  return next;
}
