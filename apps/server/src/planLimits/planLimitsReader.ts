/**
 * "AI plan limits" on Home — reading them on this computer.
 *
 * Which sign-ins: Claude Code's (`<config dir>/.credentials.json`, or on a
 * Mac the login Keychain item "Claude Code-credentials" — Claude Code keeps
 * it there and no file) and Codex's ChatGPT one (`$CODEX_HOME/auth.json`).
 * On a cloud computer both live in the daemon's own HOME (`unowork`), where
 * `claude auth login` / `codex login` from Settings put them.
 *
 * Safety:
 * - The tokens are read, never written and never refreshed: a refresh would
 *   rotate the refresh token under the CLI's feet and sign Claude Code /
 *   Codex out. A token past its expiry is not used — the last numbers stay,
 *   marked stale, until the CLI renews it on its next run.
 * - A token goes only to its own provider's usage endpoint, with a timeout;
 *   it is never logged, cached or put in an answer or an error.
 * - Keychain: `/usr/bin/security find-generic-password -w`. Claude Code
 *   writes the item through that same tool, so its access list trusts it and
 *   the read doesn't prompt (checked on a Mac 28.10). If an item made
 *   otherwise would prompt, the read is cut after a few seconds, and after
 *   that (or a "Deny") the Keychain isn't asked again until the daemon
 *   restarts — at most one prompt. It's only asked when the file has no
 *   live sign-in, and only when numbers are read; "is there a sign-in" asks
 *   for the item's attributes, which never prompts.
 * - Numbers are read at most every {@link PLAN_LIMITS_MAX_AGE_MS} (the
 *   endpoints rate-limit); the last good ones per account are kept in the
 *   state dir (`plan-limits.json`: plan, email, percentages — no tokens).
 *
 * Pure parsing lives in `planLimitsParse.ts`.
 *
 * @module planLimits/planLimitsReader
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import nodePath from "node:path";

import type {
  PlanLimits,
  PlanLimitsAccount,
  PlanLimitsProblem,
  PlanLimitsWindow,
  ServerSettings,
} from "@t3tools/contracts";

import { agentHomes } from "../skills/skillScan.ts";

import {
  chatgptPlanLabel,
  claudePlanLabel,
  claudeUsageWindows,
  codexUsage,
  parseClaudeConfig,
  parseClaudeCredentials,
  parseCodexAuth,
  sortPlanWindows,
  type ClaudeCredential,
  type CodexCredential,
} from "./planLimitsParse.ts";

/** How long numbers (or a failed read) are reused before asking again. */
export const PLAN_LIMITS_MAX_AGE_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const KEYCHAIN_TIMEOUT_MS = 4_000;

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY_BIN = "/usr/bin/security";

export interface PlanLimitsHomes {
  /** The HOME Claude Code runs with (its `.claude.json`). */
  readonly claudeHome: string;
  /** `CLAUDE_CONFIG_DIR`, else `<claudeHome>/.claude` (its `.credentials.json`). */
  readonly claudeConfigDir: string;
  /** `CODEX_HOME` (its `auth.json`). */
  readonly codexHome: string;
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? nodePath.join(home, path.slice(2)) : path;
}

/**
 * Where the CLIs the daemon runs keep their sign-ins: Claude's HOME override
 * (Settings → Claude → home path), Codex's `CODEX_HOME` — or its shadow home,
 * which keeps an `auth.json` of its own.
 */
export function planLimitsHomes(
  settings: Pick<ServerSettings, "providers">,
  home: string,
  env: NodeJS.ProcessEnv,
): PlanLimitsHomes {
  const agents = agentHomes(settings, home, env);
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const shadow = settings.providers.codex.shadowHomePath?.trim();
  return {
    claudeHome: nodePath.dirname(agents.claudeDir),
    claudeConfigDir: configDir ? expandHome(configDir, home) : agents.claudeDir,
    codexHome: shadow ? expandHome(shadow, home) : agents.codexHome,
  };
}

/** Claude Code's Keychain item (macOS only). */
export interface ClaudeKeychain {
  /** Is there an item? Attributes only — never the secret, never a prompt. */
  readonly exists: () => Promise<boolean>;
  /** The item's JSON; `blocked` once a read failed or didn't answer in time. */
  readonly read: () => Promise<{ readonly raw: string | null; readonly blocked: boolean }>;
}

export type SecurityRun = (
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false }>;

const runSecurity: SecurityRun = (args, timeoutMs) =>
  new Promise((resolve) => {
    // Killed after `timeoutMs`; stderr (which may name the item) is dropped.
    execFile(
      SECURITY_BIN,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout) => resolve(error ? { ok: false } : { ok: true, stdout: String(stdout) }),
    );
  });

/**
 * The login Keychain through `/usr/bin/security`. A read that fails or doesn't
 * answer in time (an "allow access" prompt, or "Deny") isn't tried again
 * until the daemon restarts: the item is then reported as there but locked.
 */
export function makeMacClaudeKeychain(run: SecurityRun = runSecurity): ClaudeKeychain {
  let blocked = false;
  return {
    exists: async () => {
      if (blocked) return true;
      const result = await run(["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE], 3_000);
      return result.ok;
    },
    read: async () => {
      if (blocked) return { raw: null, blocked: true };
      const result = await run(
        ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
        KEYCHAIN_TIMEOUT_MS,
      );
      if (result.ok) return { raw: result.stdout.trim(), blocked: false };
      blocked = true;
      return { raw: null, blocked: true };
    },
  };
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ cache --

interface LastGood {
  readonly plan?: string;
  readonly email?: string;
  readonly windows: ReadonlyArray<PlanLimitsWindow>;
  readonly checkedAt: string;
}

interface AccountState {
  readonly windows: ReadonlyArray<PlanLimitsWindow>;
  readonly checkedAt?: string;
  readonly plan?: string;
  readonly stale?: boolean;
  readonly problem?: PlanLimitsProblem;
}

const WINDOW_KINDS = new Set(["session", "weekly", "monthly", "other"]);

function readWindow(raw: unknown): PlanLimitsWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== "string" || !w.id || typeof w.label !== "string" || !w.label) return null;
  if (typeof w.kind !== "string" || !WINDOW_KINDS.has(w.kind)) return null;
  if (typeof w.usedPercent !== "number" || !(w.usedPercent >= 0 && w.usedPercent <= 100)) {
    return null;
  }
  return {
    id: w.id,
    kind: w.kind as PlanLimitsWindow["kind"],
    label: w.label,
    usedPercent: w.usedPercent,
    ...(typeof w.resetsAt === "string" && Number.isFinite(Date.parse(w.resetsAt))
      ? { resetsAt: w.resetsAt }
      : {}),
    ...(typeof w.windowDurationMins === "number" &&
    Number.isInteger(w.windowDurationMins) &&
    w.windowDurationMins >= 0
      ? { windowDurationMins: w.windowDurationMins }
      : {}),
    ...(typeof w.scope === "string" && w.scope ? { scope: w.scope } : {}),
  };
}

/** The cache file's accounts; anything unreadable is dropped. */
export function parsePlanLimitsCache(raw: unknown): Map<string, LastGood> {
  const out = new Map<string, LastGood>();
  const accounts = (raw as { accounts?: unknown } | null)?.accounts;
  if (typeof accounts !== "object" || accounts === null) return out;
  for (const [key, value] of Object.entries(accounts)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.checkedAt !== "string" || !Number.isFinite(Date.parse(v.checkedAt))) continue;
    if (!Array.isArray(v.windows)) continue;
    const windows = v.windows.map(readWindow).filter((w): w is PlanLimitsWindow => w !== null);
    out.set(key, {
      windows,
      checkedAt: v.checkedAt,
      ...(typeof v.plan === "string" && v.plan ? { plan: v.plan } : {}),
      ...(typeof v.email === "string" && v.email ? { email: v.email } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------- reading --

type Credential =
  | { readonly kind: "claude"; readonly value: ClaudeCredential; readonly plan?: string }
  | { readonly kind: "chatgpt"; readonly value: CodexCredential };

interface SignIn {
  readonly id: string;
  readonly provider: PlanLimitsAccount["provider"];
  readonly plan: string | undefined;
  readonly email: string | undefined;
  /** The token, read only when numbers are asked for. `locked`: the Keychain said no. */
  readonly credential: () => Promise<Credential | "locked" | null>;
}

type Fetched =
  | {
      readonly ok: true;
      readonly windows: ReadonlyArray<PlanLimitsWindow>;
      readonly plan?: string;
      readonly email?: string;
    }
  | { readonly ok: false; readonly problem: PlanLimitsProblem };

export interface PlanLimitsReaderDeps {
  /** `<stateDir>/plan-limits.json`. */
  readonly cacheFile: string;
  /** Null off macOS. */
  readonly keychain: ClaudeKeychain | null;
  readonly readText?: (path: string) => Promise<string | null>;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

export interface PlanLimitsReadInput {
  readonly homes: PlanLimitsHomes;
  readonly signInsOnly?: boolean;
}

export async function openPlanLimitsReader(deps: PlanLimitsReaderDeps) {
  const readText = deps.readText ?? readTextOrNull;
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;

  let lastGood = new Map<string, LastGood>();
  try {
    lastGood = parsePlanLimitsCache(JSON.parse(await readFile(deps.cacheFile, "utf8")));
  } catch {
    // First start or unreadable: nothing known yet.
  }
  // What the latest read concluded per account. Numbers from an earlier run
  // of the daemon are stale until read again.
  const states = new Map<string, AccountState>();
  for (const [id, good] of lastGood) {
    states.set(id, {
      windows: good.windows,
      checkedAt: good.checkedAt,
      ...(good.plan ? { plan: good.plan } : {}),
      stale: true,
    });
  }
  let lastRead: { readonly at: number; readonly result: PlanLimits } | null = null;
  let running: Promise<PlanLimits> | null = null;

  const persist = async () => {
    await mkdir(nodePath.dirname(deps.cacheFile), { recursive: true, mode: 0o700 });
    const tmp = `${deps.cacheFile}.${process.pid}.tmp`;
    const accounts = Object.fromEntries(lastGood);
    await writeFile(tmp, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(tmp, deps.cacheFile);
  };

  const claudeSignIn = async (homes: PlanLimitsHomes): Promise<SignIn | null> => {
    const file = parseClaudeCredentials(
      await readText(nodePath.join(homes.claudeConfigDir, ".credentials.json")),
    );
    const config = parseClaudeConfig(
      (await readText(nodePath.join(homes.claudeHome, ".claude.json"))) ??
        (await readText(nodePath.join(homes.claudeConfigDir, ".claude.json"))),
    );
    const fresh = (credential: ClaudeCredential | null) =>
      credential !== null && (credential.expiresAt === null || credential.expiresAt > now());
    // A Mac keeps the sign-in in the Keychain; a file there may be an old one.
    const inKeychain = !fresh(file) && deps.keychain !== null && (await deps.keychain.exists());
    if (!file && !inKeychain) return null;
    const id = `claude:${config.email ?? "default"}`;
    return {
      id,
      provider: "claude",
      plan: claudePlanLabel(file?.subscriptionType, file?.rateLimitTier ?? config.rateLimitTier),
      email: config.email,
      credential: async () => {
        const withPlan = (value: ClaudeCredential): Credential => {
          const plan = claudePlanLabel(
            value.subscriptionType,
            value.rateLimitTier ?? config.rateLimitTier,
          );
          return { kind: "claude", value, ...(plan ? { plan } : {}) };
        };
        if (!inKeychain || deps.keychain === null) return file ? withPlan(file) : null;
        const { raw, blocked } = await deps.keychain.read();
        const fromKeychain = parseClaudeCredentials(raw);
        if (fromKeychain) return withPlan(fromKeychain);
        if (file) return withPlan(file);
        return blocked ? "locked" : null;
      },
    };
  };

  const chatgptSignIn = async (homes: PlanLimitsHomes): Promise<SignIn | null> => {
    const auth = parseCodexAuth(await readText(nodePath.join(homes.codexHome, "auth.json")));
    if (!auth) return null;
    return {
      id: `chatgpt:${auth.email ?? auth.accountId ?? "default"}`,
      provider: "chatgpt",
      plan: chatgptPlanLabel(auth.planType),
      email: auth.email,
      credential: async () => ({ kind: "chatgpt", value: auth }),
    };
  };

  const signIns = async (homes: PlanLimitsHomes): Promise<SignIn[]> => {
    const found = await Promise.all([
      claudeSignIn(homes).catch(() => null),
      chatgptSignIn(homes).catch(() => null),
    ]);
    return found.filter((signIn): signIn is SignIn => signIn !== null);
  };

  const getJson = async (
    url: string,
    headers: Record<string, string>,
  ): Promise<{ readonly ok: true; readonly json: unknown } | Extract<Fetched, { ok: false }>> => {
    let response: Response;
    try {
      response = await doFetch(url, {
        headers: { Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, problem: "unreachable" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, problem: "rejected" };
    }
    if (response.status === 429) return { ok: false, problem: "busy" };
    if (!response.ok) return { ok: false, problem: "unreachable" };
    try {
      return { ok: true, json: await response.json() };
    } catch {
      return { ok: false, problem: "unexpected" };
    }
  };

  const fetchUsage = async (credential: Credential): Promise<Fetched> => {
    const expiresAt = credential.value.expiresAt;
    if (expiresAt !== null && expiresAt <= now()) return { ok: false, problem: "expired" };
    if (credential.kind === "claude") {
      const answer = await getJson(CLAUDE_USAGE_URL, {
        Authorization: `Bearer ${credential.value.accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "uno-work-plan-limits/1",
      });
      if (!answer.ok) return answer;
      const windows = claudeUsageWindows(answer.json);
      if (!windows) return { ok: false, problem: "unexpected" };
      return { ok: true, windows, ...(credential.plan ? { plan: credential.plan } : {}) };
    }
    const answer = await getJson(CHATGPT_USAGE_URL, {
      Authorization: `Bearer ${credential.value.accessToken}`,
      ...(credential.value.accountId ? { "ChatGPT-Account-Id": credential.value.accountId } : {}),
      // The endpoint serves the Codex CLI; it answers clients that name it.
      "User-Agent": "codex_cli_rs/0.50.0",
    });
    if (!answer.ok) return answer;
    const usage = codexUsage(answer.json, now());
    if (!usage) return { ok: false, problem: "unexpected" };
    const plan = chatgptPlanLabel(usage.planType);
    return {
      ok: true,
      windows: usage.windows,
      ...(plan ? { plan } : {}),
      ...(usage.email ? { email: usage.email } : {}),
    };
  };

  const accountOf = (signIn: SignIn, email?: string): PlanLimitsAccount => {
    const state = states.get(signIn.id);
    const plan = signIn.plan ?? state?.plan;
    const mail = signIn.email ?? email ?? lastGood.get(signIn.id)?.email;
    return {
      id: signIn.id,
      provider: signIn.provider,
      ...(plan ? { plan } : {}),
      ...(mail ? { email: mail } : {}),
      windows: state ? [...state.windows] : [],
      ...(state?.checkedAt ? { checkedAt: state.checkedAt } : {}),
      ...(state?.stale ? { stale: true } : {}),
      ...(state?.problem ? { problem: state.problem } : {}),
    };
  };

  const readAll = async (homes: PlanLimitsHomes): Promise<PlanLimits> => {
    const found = await signIns(homes);
    let changed = false;
    const accounts = await Promise.all(
      found.map(async (signIn): Promise<PlanLimitsAccount | null> => {
        const credential = await signIn.credential().catch(() => null);
        if (credential === null) return null;
        const fetched: Fetched =
          credential === "locked"
            ? { ok: false, problem: "locked" }
            : await fetchUsage(credential).catch(
                (): Fetched => ({ ok: false, problem: "unexpected" }),
              );
        const previous = states.get(signIn.id);
        if (fetched.ok) {
          const checkedAt = new Date(now()).toISOString();
          const plan = fetched.plan ?? signIn.plan ?? previous?.plan;
          const email = signIn.email ?? fetched.email;
          states.set(signIn.id, {
            windows: sortPlanWindows(fetched.windows),
            checkedAt,
            ...(plan ? { plan } : {}),
          });
          lastGood.set(signIn.id, {
            windows: sortPlanWindows(fetched.windows),
            checkedAt,
            ...(plan ? { plan } : {}),
            ...(email ? { email } : {}),
          });
          changed = true;
          return accountOf(signIn, fetched.email);
        }
        states.set(signIn.id, {
          windows: previous?.windows ?? [],
          ...(previous?.checkedAt ? { checkedAt: previous.checkedAt } : {}),
          ...(previous?.plan ? { plan: previous.plan } : {}),
          ...(previous && previous.windows.length > 0 ? { stale: true } : {}),
          problem: fetched.problem,
        });
        return accountOf(signIn);
      }),
    );
    if (changed) await persist().catch(() => undefined);
    return { accounts: accounts.filter((a): a is PlanLimitsAccount => a !== null) };
  };

  /**
   * The sign-ins and their limits. `signInsOnly`: local files only, nothing
   * sent; windows as last read. Otherwise reads again when the last read is
   * older than {@link PLAN_LIMITS_MAX_AGE_MS}; concurrent callers share one.
   * Never rejects.
   */
  const read = async (input: PlanLimitsReadInput): Promise<PlanLimits> => {
    try {
      if (input.signInsOnly) {
        const found = await signIns(input.homes);
        return { accounts: found.map((signIn) => accountOf(signIn)) };
      }
      if (running) return await running;
      if (lastRead && now() - lastRead.at < PLAN_LIMITS_MAX_AGE_MS) return lastRead.result;
      running = readAll(input.homes)
        .then((result) => {
          lastRead = { at: now(), result };
          return result;
        })
        .finally(() => {
          running = null;
        });
      return await running;
    } catch {
      return { accounts: [] };
    }
  };

  return { read };
}

export type PlanLimitsReader = Awaited<ReturnType<typeof openPlanLimitsReader>>;
