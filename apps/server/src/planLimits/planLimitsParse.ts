/**
 * "AI plan limits" on Home — the pure part: what the CLIs' sign-in files say
 * (plan, email, the token and when it runs out) and what the providers'
 * usage endpoints answer, as windows of the contract (`PlanLimitsWindow`,
 * upstream's `ServerProviderUsageWindow` shape and ids).
 *
 * - Claude: `GET api.anthropic.com/api/oauth/usage` — a `limits` array
 *   (`session`, `weekly_all`, `weekly_scoped` with the model) since autumn
 *   2026, and the older keyed windows (`five_hour`, `seven_day`,
 *   `seven_day_opus`…) next to it. Percentages are 0–100.
 * - ChatGPT: `GET chatgpt.com/backend-api/wham/usage` (what Codex's `/status`
 *   reads) — `rate_limit.primary_window` / `secondary_window` with the
 *   window's length in seconds; Free and Go plans have one monthly window.
 *
 * Both endpoints are undocumented: anything unexpected is skipped, never
 * guessed. Ported from Misha's `tools/ai-limits/collect.mjs`.
 *
 * @module planLimits/planLimitsParse
 */
import type { PlanLimitsWindow } from "@t3tools/contracts";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

const KIND_ORDER: Record<PlanLimitsWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function isoFromString(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function isoFromEpochSeconds(value: unknown): string | undefined {
  const seconds = finite(value);
  return seconds !== undefined && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/** Plan-wide windows first (session, week, month), then the per-model ones. */
export function sortPlanWindows(
  windows: ReadonlyArray<PlanLimitsWindow>,
): ReadonlyArray<PlanLimitsWindow> {
  return windows.toSorted(
    (a, b) =>
      Number(a.scope !== undefined) - Number(b.scope !== undefined) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.id.localeCompare(b.id),
  );
}

/** A JWT's claims, unverified — only to read the plan, the email and `exp`. */
export function jwtClaims(token: unknown): Json | null {
  if (typeof token !== "string") return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return asObject(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------- Claude --

/** `max` + `default_claude_max_20x` → "Max 20x"; "Pro", "Team"… */
export function claudePlanLabel(
  subscriptionType: string | undefined,
  rateLimitTier: string | undefined,
): string | undefined {
  const multiplier = rateLimitTier?.match(/max_(\d+)x/)?.[1];
  if (!subscriptionType) return multiplier ? `Max ${multiplier}x` : undefined;
  if (subscriptionType.toLowerCase() === "max") return multiplier ? `Max ${multiplier}x` : "Max";
  return titleCase(subscriptionType);
}

export interface ClaudeCredential {
  readonly accessToken: string;
  /** Epoch ms; null when the file doesn't say. */
  readonly expiresAt: number | null;
  readonly subscriptionType: string | undefined;
  readonly rateLimitTier: string | undefined;
}

/**
 * Claude Code's sign-in (`~/.claude/.credentials.json`, or the macOS
 * Keychain item "Claude Code-credentials" — the same JSON):
 * `claudeAiOauth.accessToken`. An API-key or Uno AI setup has none.
 */
export function parseClaudeCredentials(raw: string | null): ClaudeCredential | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = asObject(asObject(json)?.claudeAiOauth);
  const accessToken = text(oauth?.accessToken);
  if (!oauth || !accessToken) return null;
  return {
    accessToken,
    expiresAt: finite(oauth.expiresAt) ?? null,
    subscriptionType: text(oauth.subscriptionType),
    rateLimitTier: text(oauth.rateLimitTier),
  };
}

/** `~/.claude.json` → the signed-in account's email and rate-limit tier. */
export function parseClaudeConfig(raw: string | null): {
  readonly email: string | undefined;
  readonly rateLimitTier: string | undefined;
} {
  let account: Json | null = null;
  try {
    account = raw === null ? null : asObject(asObject(JSON.parse(raw))?.oauthAccount);
  } catch {
    account = null;
  }
  return {
    email: text(account?.emailAddress),
    rateLimitTier: text(account?.organizationRateLimitTier) ?? text(account?.userRateLimitTier),
  };
}

function claudeScopeName(scope: unknown): string | undefined {
  const value = asObject(scope);
  if (!value) return undefined;
  const surface = value.surface;
  return (
    text(asObject(value.model)?.display_name) ??
    text(asObject(surface)?.display_name) ??
    text(surface)
  );
}

function claudeScopedWindow(
  name: string,
  usedPercent: number,
  resetsAt: string | undefined,
): PlanLimitsWindow {
  return {
    id: `seven_day_${slug(name)}`,
    kind: "weekly",
    label: `Weekly · ${name}`,
    usedPercent: clampPercent(usedPercent),
    windowDurationMins: WEEK_MINS,
    scope: name,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function claudeLimitsArray(entries: ReadonlyArray<unknown>): PlanLimitsWindow[] {
  const out: PlanLimitsWindow[] = [];
  for (const entry of entries) {
    const limit = asObject(entry);
    const percent = finite(limit?.percent);
    const kind = text(limit?.kind);
    if (!limit || percent === undefined || !kind) continue;
    const resetsAt = isoFromString(limit.resets_at);
    const reset = resetsAt ? { resetsAt } : {};
    if (kind === "session") {
      out.push({
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: clampPercent(percent),
        windowDurationMins: SESSION_MINS,
        ...reset,
      });
    } else if (kind === "weekly_all") {
      out.push({
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: clampPercent(percent),
        windowDurationMins: WEEK_MINS,
        ...reset,
      });
    } else if (kind === "weekly_scoped") {
      const name = claudeScopeName(limit.scope);
      if (name) out.push(claudeScopedWindow(name, percent, resetsAt));
    } else {
      // A kind this daemon doesn't know yet: kept, filed under its group.
      const group = text(limit.group);
      const scope = claudeScopeName(limit.scope);
      out.push({
        id: scope ? `${slug(kind)}_${slug(scope)}` : slug(kind),
        kind: group === "session" || group === "weekly" || group === "monthly" ? group : "other",
        label: scope ? `${titleCase(kind)} · ${scope}` : titleCase(kind),
        usedPercent: clampPercent(percent),
        ...(scope ? { scope } : {}),
        ...reset,
      });
    }
  }
  return out;
}

/** The keyed windows the endpoint had before (and still sends next to) `limits`. */
function claudeKeyedWindows(json: Json): PlanLimitsWindow[] {
  const out: PlanLimitsWindow[] = [];
  const keyed = (key: string) => {
    const window = asObject(json[key]);
    const percent = finite(window?.utilization);
    return percent === undefined ? null : { percent, resetsAt: isoFromString(window?.resets_at) };
  };
  const session = keyed("five_hour");
  if (session) {
    out.push({
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: clampPercent(session.percent),
      windowDurationMins: SESSION_MINS,
      ...(session.resetsAt ? { resetsAt: session.resetsAt } : {}),
    });
  }
  const week = keyed("seven_day");
  if (week) {
    out.push({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(week.percent),
      windowDurationMins: WEEK_MINS,
      ...(week.resetsAt ? { resetsAt: week.resetsAt } : {}),
    });
  }
  for (const [key, name] of [
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
  ] as const) {
    const scoped = keyed(key);
    if (scoped) out.push(claudeScopedWindow(name, scoped.percent, scoped.resetsAt));
  }
  // The Agent SDK's `get_usage` shape (upstream reads it): named per-model weeks.
  if (Array.isArray(json.model_scoped)) {
    for (const entry of json.model_scoped) {
      const scoped = asObject(entry);
      const name = text(scoped?.display_name);
      const percent = finite(scoped?.utilization);
      if (name && percent !== undefined) {
        out.push(claudeScopedWindow(name, percent, isoFromString(scoped?.resets_at)));
      }
    }
  }
  return out;
}

/** Extra usage (paid past the plan) — a monthly window only when it's on. */
function claudeSpendWindow(json: Json): PlanLimitsWindow | null {
  const ratio = (used: unknown, limit: unknown) => {
    const u = finite(used);
    const l = finite(limit);
    return u !== undefined && l !== undefined && u >= 0 && l > 0 ? (u / l) * 100 : undefined;
  };
  let percent: number | undefined;
  const spend = asObject(json.spend);
  if (spend?.enabled === true) {
    const used = asObject(spend.used);
    const limit = asObject(spend.limit);
    percent =
      used &&
      limit &&
      text(used.currency) === text(limit.currency) &&
      used.exponent === limit.exponent
        ? ratio(used.amount_minor, limit.amount_minor)
        : undefined;
    percent ??= finite(spend.percent);
  }
  const extra = asObject(json.extra_usage);
  if (percent === undefined && extra?.is_enabled === true) {
    percent = ratio(extra.used_credits, extra.monthly_limit) ?? finite(extra.utilization);
  }
  return percent === undefined
    ? null
    : {
        id: "monthly_spend",
        kind: "monthly",
        label: "Monthly spend",
        usedPercent: clampPercent(percent),
      };
}

/** The usage answer → windows; null when it isn't one (nothing readable in it). */
export function claudeUsageWindows(json: unknown): ReadonlyArray<PlanLimitsWindow> | null {
  const body = asObject(json);
  if (!body) return null;
  const fromArray = Array.isArray(body.limits) ? claudeLimitsArray(body.limits) : [];
  const windows = fromArray.length > 0 ? fromArray : claudeKeyedWindows(body);
  const spend = claudeSpendWindow(body);
  if (spend) windows.push(spend);
  if (windows.length === 0 && !("five_hour" in body) && !("limits" in body)) return null;
  return sortPlanWindows(windows);
}

// ---------------------------------------------------------------- ChatGPT --

const CHATGPT_PLANS: Readonly<Record<string, string>> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  edu: "Edu",
};

export function chatgptPlanLabel(planType: string | undefined): string | undefined {
  if (!planType) return undefined;
  return CHATGPT_PLANS[planType.toLowerCase()] ?? titleCase(planType);
}

export interface CodexCredential {
  readonly accessToken: string;
  readonly accountId: string | undefined;
  readonly email: string | undefined;
  readonly planType: string | undefined;
  /** Epoch ms of the access token's `exp`; null when it doesn't say. */
  readonly expiresAt: number | null;
}

/**
 * Codex's ChatGPT sign-in (`$CODEX_HOME/auth.json`): `tokens.access_token`,
 * the account id and the id token's claims (email, plan). An API key alone
 * (`OPENAI_API_KEY`) has no plan limits — null.
 */
export function parseCodexAuth(raw: string | null): CodexCredential | null {
  if (raw === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const tokens = asObject(asObject(json)?.tokens);
  const accessToken = text(tokens?.access_token);
  if (!tokens || !accessToken) return null;
  const id = jwtClaims(tokens.id_token);
  const auth = asObject(id?.["https://api.openai.com/auth"]);
  const profile = asObject(id?.["https://api.openai.com/profile"]);
  const exp = finite(jwtClaims(accessToken)?.exp);
  return {
    accessToken,
    accountId: text(tokens.account_id) ?? text(auth?.chatgpt_account_id),
    email: text(id?.email) ?? text(profile?.email),
    planType: text(auth?.chatgpt_plan_type),
    expiresAt: exp !== undefined ? exp * 1000 : null,
  };
}

function codexKind(mins: number): PlanLimitsWindow["kind"] {
  if (mins >= MONTH_MINS) return "monthly";
  if (mins >= WEEK_MINS) return "weekly";
  return "session";
}

const CODEX_KIND_LABEL: Record<PlanLimitsWindow["kind"], string> = {
  session: "Session",
  weekly: "Weekly",
  monthly: "Monthly",
  other: "Limit",
};

function codexWindows(
  rateLimit: unknown,
  input: { readonly prefix: string; readonly scope?: string; readonly monthlyPlan: boolean },
  nowMs: number,
): PlanLimitsWindow[] {
  const limits = asObject(rateLimit);
  if (!limits) return [];
  const out: PlanLimitsWindow[] = [];
  const positions = [
    ["primary", limits.primary_window, input.monthlyPlan ? MONTH_MINS : SESSION_MINS],
    ["secondary", limits.secondary_window, WEEK_MINS],
  ] as const;
  for (const [position, raw, fallbackMins] of positions) {
    const window = asObject(raw);
    const percent = finite(window?.used_percent);
    if (!window || percent === undefined) continue;
    const seconds = finite(window.limit_window_seconds);
    const mins = seconds !== undefined && seconds > 0 ? Math.round(seconds / 60) : fallbackMins;
    const kind = codexKind(mins);
    const after = finite(window.reset_after_seconds);
    const resetsAt =
      isoFromEpochSeconds(window.reset_at) ??
      (after !== undefined && after >= 0
        ? new Date(nowMs + after * 1000).toISOString()
        : undefined);
    out.push({
      id: input.prefix ? `${input.prefix}_${position}` : position,
      kind,
      label: input.scope ? `${CODEX_KIND_LABEL[kind]} · ${input.scope}` : CODEX_KIND_LABEL[kind],
      usedPercent: clampPercent(percent),
      windowDurationMins: mins,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return out;
}

export interface CodexUsage {
  readonly windows: ReadonlyArray<PlanLimitsWindow>;
  readonly planType: string | undefined;
  readonly email: string | undefined;
}

/**
 * The usage answer → windows, plus the plan and email it names; null when it
 * isn't one. Code review's own limit is left out (not a chat limit).
 */
export function codexUsage(json: unknown, nowMs: number): CodexUsage | null {
  const body = asObject(json);
  if (!body || !("rate_limit" in body)) return null;
  const planType = text(body.plan_type);
  const monthlyPlan = planType === "free" || planType === "go";
  const windows = codexWindows(body.rate_limit, { prefix: "", monthlyPlan }, nowMs);
  if (Array.isArray(body.additional_rate_limits)) {
    for (const entry of body.additional_rate_limits) {
      const extra = asObject(entry);
      const name = text(extra?.limit_name) ?? text(extra?.metered_feature);
      if (!extra || !name) continue;
      windows.push(
        ...codexWindows(extra.rate_limit, { prefix: slug(name), scope: name, monthlyPlan }, nowMs),
      );
    }
  }
  return { windows: sortPlanWindows(windows), planType, email: text(body.email) };
}
