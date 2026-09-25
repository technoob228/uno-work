/**
 * "My Uno" — everything on the Uno account in one window: computers (with
 * their role, state, size, what runs on them and what they cost), sites on
 * Uno Hosting, the cloud, the plan, the balance, Uno AI credits and payments.
 *
 * All of it is read from the console as the signed-in person, through the same
 * interface allowlist as the computer list (see unoAccount.ts). Money never
 * moves from here: switching plans and adding money open the console, where
 * the person is already signed in.
 *
 * Parsers are tolerant (a field the console does not send yet reads as
 * empty, never as a crash) and free of React, so they are unit-tested
 * against recorded payloads.
 */
import { ControlPlaneHttpError, controlPlaneErrorStatus } from "@t3tools/shared/unoCloud";

import { accountRequest } from "./unoAccount";
import { type ComputerRole, computerRole, parseRoleComment, withRole } from "./computerRoles";

export const CONSOLE_URL = "https://console.uno4.dev";

// ---- small readers ----

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function strOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function list(value: unknown, key?: string): unknown[] {
  if (Array.isArray(value)) return value;
  const inner = key ? rec(value)?.[key] : undefined;
  return Array.isArray(inner) ? inner : [];
}

// ---- computers ----

export interface AccountComputer {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly ramMb: number;
  readonly vcpu: number;
  readonly diskGb: number;
  readonly workMachine: boolean;
  readonly role: ComputerRole;
  /** The comment without the role tag — the person's own note. */
  readonly note: string;
  readonly comment: string;
  /**
   * The console keeps the role in its own `computer_role` field (migration
   * 139). False = an older console: the role is written as a comment tag.
   */
  readonly roleInField: boolean;
  readonly alwaysOn: boolean;
  readonly wakeOnHttp: boolean;
  readonly startedAt: string | null;
  readonly createdAt: string | null;
  readonly url: string | null;
  /** The last Restart (for ~10 minutes after it); null = none lately. */
  readonly restart: ComputerRestart | null;
}

export function parseAccountComputer(raw: unknown): AccountComputer | null {
  const r = rec(raw);
  if (!r) return null;
  const id = num(r["id"], -1);
  if (id <= 0) return null;
  const status = str(r["status"]) || "unknown";
  if (status === "deleted") return null;
  const workMachine = r["work_machine"] === true || r["role"] === "work";
  const comment = str(r["comment"]);
  const roleInField = "computer_role" in r;
  return {
    id,
    name: str(r["name"]) || `computer-${id}`,
    status,
    ramMb: num(r["ram_mb"]),
    vcpu: num(r["vcpu"]),
    diskGb: num(r["disk_gb"]),
    workMachine,
    role: computerRole({ workMachine, roleField: r["computer_role"], comment }),
    note: parseRoleComment(comment).note,
    comment,
    roleInField,
    alwaysOn: r["always_on"] === true,
    wakeOnHttp: r["wake_on_http"] === true,
    startedAt: strOrNull(r["started_at"]),
    createdAt: strOrNull(r["created_at"]),
    url: strOrNull(r["url"]),
    restart: parseComputerRestart(r["restart"]),
  };
}

export async function fetchAccountComputers(): Promise<ReadonlyArray<AccountComputer>> {
  const raw = await accountRequest("GET", "/api/v1/boxes");
  return list(raw, "boxes")
    .map(parseAccountComputer)
    .filter((box): box is AccountComputer => box !== null);
}

// ---- restart ----

/**
 * A safe restart (`POST /api/v1/boxes/{id}/restart`): Uno flushes the disk,
 * lets the computer shut down, then boots it again from its own disk. It is
 * offline for about 15 seconds; the console reports how it went in the
 * computer's `restart` field.
 */
export interface ComputerRestart {
  readonly state: "restarting" | "done" | "failed";
  readonly requestedAt: string | null;
  readonly finishedAt: string | null;
  readonly error: string | null;
}

export function parseComputerRestart(raw: unknown): ComputerRestart | null {
  const r = rec(raw);
  if (!r) return null;
  const state = str(r["state"]);
  if (state !== "restarting" && state !== "done" && state !== "failed") return null;
  return {
    state,
    requestedAt: strOrNull(r["requested_at"]),
    finishedAt: strOrNull(r["finished_at"]),
    error: strOrNull(r["error"]),
  };
}

export async function restartComputer(id: number): Promise<ComputerRestart | null> {
  const raw = await accountRequest("POST", `/api/v1/boxes/${id}/restart`, {});
  return parseComputerRestart(rec(raw)?.["restart"]);
}

/** The console's refusal in the person's words. */
export function describeRestartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const has = (code: string) => raw.includes(code);
  if (has("RESTART_TOO_SOON")) {
    return "It was restarted less than a minute ago. Try again in a moment.";
  }
  if (has("BOX_NOT_RUNNING")) return "Only a running computer can be restarted. Wake it up first.";
  if (has("BOX_BUSY"))
    return "It's busy right now (restarting or switching boost). Try again in a minute.";
  if (/^403\b/.test(raw)) return "Only the account owner can restart it.";
  const detail = raw.replace(/^\d{3}:\s*/, "").replace(/^\{"error":"(.*)"\}$/, "$1");
  return `Uno couldn't restart it: ${detail.slice(0, 200)}`;
}

/**
 * The body that changes a computer's role: the field alone on a console that
 * has it (the person's note is left untouched), the comment tag otherwise.
 */
export function roleChangeBody(computer: AccountComputer, role: ComputerRole) {
  return computer.roleInField
    ? { computer_role: role }
    : { comment: withRole(computer.comment, role) };
}

export async function setComputerRole(computer: AccountComputer, role: ComputerRole) {
  await accountRequest("PATCH", `/api/v1/boxes/${computer.id}`, roleChangeBody(computer, role));
}

export async function createServerComputer(input: {
  readonly name: string;
  readonly role: ComputerRole;
  readonly ramMb: number;
  readonly vcpu: number;
  readonly diskGb: number;
}): Promise<AccountComputer | null> {
  const raw = await accountRequest("POST", "/api/v1/work/servers", {
    name: input.name,
    ram_mb: input.ramMb,
    vcpu: input.vcpu,
    disk_gb: input.diskGb,
    // Both: a console with the field takes computer_role (and drops the tag
    // from the comment); an older one ignores the field and keeps the tag.
    computer_role: input.role,
    comment: withRole("", input.role),
  });
  return parseAccountComputer(raw);
}

/**
 * Why a new computer wasn't created, in words: the console answers with a
 * code (SHAPE_TOO_LARGE, PEAK_EXCEEDED…) inside the error text. `plan` = the
 * fix is a bigger plan (the dialog then offers "See plans").
 */
export function describeCreateError(error: unknown): { message: string; plan: boolean } {
  const raw = error instanceof Error ? error.message : String(error);
  const has = (code: string) => raw.includes(code);
  if (has("SHAPE_TOO_LARGE")) {
    return { message: "That's bigger than one computer on your plan can be.", plan: true };
  }
  if (has("PEAK_EXCEEDED") || has("POOL_EXHAUSTED")) {
    return {
      message:
        "Your plan is already running as much as it can at once. Put a computer to sleep or pick a bigger plan.",
      plan: true,
    };
  }
  if (has("DISK_QUOTA_EXCEEDED")) {
    return { message: "Your plan's working disk is full.", plan: true };
  }
  if (has("NO_SUBSCRIPTION") || has("SUBSCRIPTION_REQUIRED")) {
    return { message: "Computers in the cloud come with a plan.", plan: true };
  }
  if (has("BOX_LIMIT") || has("QUOTA")) {
    return { message: "Your plan has no room for another computer.", plan: true };
  }
  const detail = raw.replace(/^\d{3}:\s*/, "").replace(/^\{"error":"(.*)"\}$/, "$1");
  return { message: `Uno couldn't create it: ${detail.slice(0, 200)}`, plan: false };
}

// ---- a server without Uno Work: monitor, apps, logs ----

export interface ComputerMetrics {
  readonly live: boolean;
  readonly cpuPct: number | null;
  readonly memUsedMb: number | null;
  readonly memLimitMb: number | null;
  readonly diskUsedGb: number | null;
  readonly diskTotalGb: number | null;
  readonly uptimeS: number | null;
}

function maybe(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseComputerMetrics(raw: unknown): ComputerMetrics {
  const r = rec(raw) ?? {};
  const cpu = rec(r["cpu"]);
  const mem = rec(r["mem"]);
  const disk = rec(r["disk"]);
  return {
    live: r["live"] === true || r["ok"] === true,
    cpuPct: maybe(cpu?.["usage_pct"]),
    memUsedMb: maybe(mem?.["used_mb"]),
    memLimitMb: maybe(mem?.["limit_mb"]),
    diskUsedGb: maybe(disk?.["used_gb"]),
    diskTotalGb: maybe(disk?.["total_gb"]),
    uptimeS: maybe(r["uptime_s"]),
  };
}

export async function fetchComputerMetrics(id: number): Promise<ComputerMetrics> {
  return parseComputerMetrics(await accountRequest("GET", `/api/v1/boxes/${id}/metrics`));
}

export interface ComputerApp {
  readonly id: number;
  readonly name: string;
  readonly icon: string;
  readonly status: string;
  readonly url: string | null;
}

export function parseComputerApps(raw: unknown): ReadonlyArray<ComputerApp> {
  return list(raw, "apps").flatMap((item) => {
    const r = rec(item);
    if (!r) return [];
    const id = num(r["deployment_id"], -1);
    if (id <= 0) return [];
    return [
      {
        id,
        name: str(r["name"]) || str(r["template_id"]) || "App",
        icon: str(r["icon"]),
        status: str(r["status"]) || "unknown",
        url: strOrNull(r["url"]),
      },
    ];
  });
}

export async function fetchComputerApps(id: number): Promise<ReadonlyArray<ComputerApp>> {
  return parseComputerApps(await accountRequest("GET", `/api/v1/boxes/${id}/apps`));
}

export interface ComputerLogs {
  readonly lines: ReadonlyArray<string>;
  readonly error: string | null;
}

export function parseComputerLogs(raw: unknown): ComputerLogs {
  const r = rec(raw) ?? {};
  return {
    lines: list(r["lines"]).map((line) => str(rec(line)?.["line"] ?? line)),
    error: strOrNull(r["error"]),
  };
}

export async function fetchComputerLogs(id: number, tail = 200): Promise<ComputerLogs> {
  return parseComputerLogs(
    await accountRequest("GET", `/api/v1/boxes/${id}/applogs?source=auto&tail=${tail}`),
  );
}

// ---- plans and the subscription ----

export interface AccountPlan {
  readonly slug: string;
  readonly name: string;
  readonly priceUsd: number;
  /** The computer part of the price; the rest is Uno AI credits. */
  readonly computePriceUsd: number;
  readonly generation: number;
  /** The same computer with and without Uno AI share this (`plus`, `plus-ai`). */
  readonly baseSlug: string;
  /** Premium credit a month (before AI hours: all Uno AI credits). */
  readonly aiCreditsUsd: number;
  /**
   * Uno AI hours (spec ai-hours.md): hours a month, AI power (×1…×8) and the
   * premium credit. Null on a console without AI hours.
   */
  readonly aiHoursMonthly: number | null;
  readonly aiHoursUnlimited: boolean;
  /** Unlimited plans: active hours a period at full speed, then standard speed. */
  readonly aiFullSpeedHours: number | null;
  readonly aiPower: number | null;
  readonly aiPremiumUsd: number | null;
  /** The biggest single computer. */
  readonly maxBoxRamMb: number;
  readonly maxBoxVcpu: number;
  /** Everything running at once. */
  readonly peakRamMb: number;
  readonly peakVcpu: number;
  readonly diskGb: number;
  readonly cloudGb: number;
  readonly boostHours: number;
  /** Uno Work can run in the cloud on this plan (≥ 4 GB computers). */
  readonly cloudWork: boolean;
  readonly legacy: boolean;
}

export function parseAccountPlan(raw: unknown): AccountPlan | null {
  const r = rec(raw);
  const slug = str(r?.["slug"]);
  if (!r || !slug) return null;
  const maxBox = rec(r["max_box"]);
  const peak = rec(r["peak"]);
  const price = num(r["price_usd"]);
  const maxBoxRamMb = num(maxBox?.["ram_mb"]);
  return {
    slug,
    name: str(r["name"]) || titleCase(slug),
    priceUsd: price,
    computePriceUsd: num(r["compute_price_usd"], price),
    generation: Math.max(1, num(r["generation"], 1)),
    baseSlug: str(r["base_slug"]) || slug,
    aiCreditsUsd: num(r["ai_credits_usd"]),
    aiHoursMonthly: numOrNull(r["ai_hours_monthly"]),
    aiHoursUnlimited: r["ai_hours_unlimited"] === true,
    aiFullSpeedHours: numOrNull(r["ai_full_speed_hours"]),
    aiPower: numOrNull(r["ai_power"]),
    aiPremiumUsd: numOrNull(r["ai_premium_usd"]),
    maxBoxRamMb,
    maxBoxVcpu: num(maxBox?.["vcpu"]),
    peakRamMb: num(peak?.["ram_mb"], maxBoxRamMb),
    peakVcpu: num(peak?.["vcpu"], num(maxBox?.["vcpu"])),
    diskGb: num(r["disk_gb"]),
    cloudGb: num(r["s3_gb"]),
    boostHours: num(r["boost_hours"]),
    // The console decides (the Plus+ ladder); older consoles don't send the
    // field, and there a 4 GB computer was the line.
    cloudWork: "cloud_work" in r ? r["cloud_work"] === true : maxBoxRamMb >= 4096,
    legacy: r["legacy"] === true,
  };
}

function titleCase(slug: string): string {
  return slug.replace(
    /(^|-)([a-z])/g,
    (_m, dash: string, c: string) => (dash ? " " : "") + c.toUpperCase(),
  );
}

export interface PlanCatalog {
  readonly plans: ReadonlyArray<AccountPlan>;
  /** The account sees the "plan = computer" ladder (PLANS_V2). */
  readonly plansV2: boolean;
}

export function parsePlanCatalog(raw: unknown): PlanCatalog {
  return {
    plans: list(raw, "plans")
      .map(parseAccountPlan)
      .filter((plan): plan is AccountPlan => plan !== null),
    plansV2: rec(raw)?.["plans_v2"] === true,
  };
}

export async function fetchPlanCatalog(): Promise<PlanCatalog> {
  return parsePlanCatalog(await accountRequest("GET", "/api/v1/work/plans"));
}

export interface AccountSubscription {
  readonly plan: string;
  readonly status: string;
  readonly priceUsd: number;
  readonly periodStart: string | null;
  readonly nextBillingAt: string | null;
  readonly pendingPlan: string | null;
  readonly trialExpiresAt: string | null;
  readonly limits: AccountPlan | null;
  /** Disk granted by hand over the plan's, when set. */
  readonly diskGbOverride: number | null;
  readonly aiCredits: {
    readonly monthlyUsd: number;
    readonly periodUsd: number;
    readonly carryUsd: number;
  };
  /** Uno AI hours; null on a console without them (or the flag is off). */
  readonly aiHours: SubscriptionAiHours | null;
  /** AI power of the plan; null when the console does not say. */
  readonly aiPower: { readonly multiplier: number; readonly usdPerHour: number | null } | null;
  readonly usage: {
    readonly runningRamMb: number;
    readonly runningVcpu: number;
    readonly diskGbUsed: number;
    readonly boxCount: number;
  };
}

export interface SubscriptionAiHours {
  /** Minutes left; null for unlimited plans. */
  readonly balanceMinutes: number | null;
  readonly monthlyHours: number;
  readonly usedThisPeriodMinutes: number;
  readonly usedTodayMinutes: number | null;
  readonly neverExpire: boolean;
  readonly expiresAt: string | null;
  /** Max+AI: no hours limit (full speed for the month's hours, then standard). */
  readonly unlimited: boolean;
}

export function parseSubscriptionAiHours(raw: unknown): SubscriptionAiHours | null {
  const r = rec(raw);
  if (!r) return null;
  const unlimited = r["unlimited"] === true;
  const balanceMinutes = numOrNull(r["balance_minutes"]);
  if (balanceMinutes === null && !unlimited) return null;
  return {
    balanceMinutes,
    monthlyHours: num(r["monthly_hours"]),
    usedThisPeriodMinutes: num(r["used_this_period_minutes"]),
    usedTodayMinutes: numOrNull(r["used_today_minutes"]),
    neverExpire: r["never_expire"] !== false,
    expiresAt: strOrNull(r["expires_at"]),
    unlimited,
  };
}

export function parseSubscription(raw: unknown): AccountSubscription | null {
  const r = rec(raw);
  const plan = str(r?.["plan"]);
  if (!r || !plan) return null;
  const usage = rec(r["usage"]);
  const ai = rec(r["ai_credits"]);
  const power = rec(r["ai_power"]);
  const override = r["disk_gb_override"];
  return {
    plan,
    status: str(r["status"]) || "active",
    priceUsd: num(r["price_usd"]),
    periodStart: strOrNull(r["period_start"]),
    nextBillingAt: strOrNull(r["next_billing_at"]),
    pendingPlan: strOrNull(r["pending_plan"]),
    trialExpiresAt: strOrNull(r["trial_expires_at"]),
    limits: parseAccountPlan(r["plan_limits"]),
    diskGbOverride: typeof override === "number" && override > 0 ? override : null,
    aiCredits: {
      monthlyUsd: num(ai?.["monthly_usd"]),
      periodUsd: num(ai?.["period_usd"]),
      carryUsd: num(ai?.["carry_usd"]),
    },
    aiHours: parseSubscriptionAiHours(r["ai_hours"]),
    aiPower:
      power && numOrNull(power["multiplier"]) !== null
        ? { multiplier: num(power["multiplier"]), usdPerHour: numOrNull(power["usd_per_hour"]) }
        : null,
    usage: {
      runningRamMb: num(usage?.["running_ram_mb"]),
      runningVcpu: num(usage?.["running_vcpu"]),
      diskGbUsed: num(usage?.["disk_gb_used"]),
      boxCount: num(usage?.["box_count"]),
    },
  };
}

/** Null when the account has no plan (the console answers 404). */
export async function fetchSubscription(): Promise<AccountSubscription | null> {
  try {
    return parseSubscription(await accountRequest("GET", "/api/v1/box-subscription"));
  } catch (error) {
    if (controlPlaneErrorStatus(error) === 404) return null;
    throw error;
  }
}

// ---- balance ----

export interface AccountBalance {
  readonly email: string | null;
  readonly username: string | null;
  /**
   * The person's first name: `/auth/me` `first_name`, taken from the linked
   * Telegram (empty when there is none). Home greets by it first.
   */
  readonly name: string | null;
  readonly balanceUsd: number;
  /** `llm_balance`: premium credit + top-ups (all Uno AI credits before AI hours). */
  readonly aiBalanceUsd: number;
  /** `ai_hours_minutes`; null when the console does not send it. */
  readonly aiHoursMinutes: number | null;
}

export async function fetchBalance(): Promise<AccountBalance> {
  const me = rec(await accountRequest("GET", "/auth/me")) ?? {};
  return {
    email: strOrNull(me["email"]),
    username: strOrNull(me["username"]),
    name:
      strOrNull(me["first_name"]) ??
      strOrNull(me["name"]) ??
      strOrNull(me["full_name"]) ??
      strOrNull(me["display_name"]),
    balanceUsd: num(me["balance"]),
    aiBalanceUsd: num(me["llm_balance"]),
    aiHoursMinutes: numOrNull(me["ai_hours_minutes"]),
  };
}

// ---- sites ----

export interface HostedSite {
  readonly slug: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly filesCount: number;
  readonly customDomain: string | null;
  readonly hasPassword: boolean;
  readonly updatedAt: string | null;
  readonly expiresAt: string | null;
}

export interface SitesState {
  readonly sites: ReadonlyArray<HostedSite>;
  readonly usedBytes: number;
  readonly limitBytes: number;
}

export function parseSites(raw: unknown): SitesState {
  const r = rec(raw) ?? {};
  const sites = list(r["deploys"]).flatMap((item): HostedSite[] => {
    const d = rec(item);
    const slug = str(d?.["slug"]);
    if (!d || !slug) return [];
    const domain = strOrNull(d["custom_domain"]);
    return [
      {
        slug,
        url: domain ? `https://${domain}` : str(d["url"]) || `https://${slug}.uno4.dev`,
        sizeBytes: num(d["size_bytes"]),
        filesCount: num(d["files_count"]),
        customDomain: domain,
        hasPassword: d["has_password"] === true,
        updatedAt: strOrNull(d["updated_at"]) ?? strOrNull(d["created_at"]),
        expiresAt: strOrNull(d["expires_at"]),
      },
    ];
  });
  return {
    sites: sites.toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")),
    usedBytes: num(r["storage_used_bytes"]),
    limitBytes: num(r["storage_limit_bytes"]),
  };
}

export async function fetchSites(): Promise<SitesState> {
  return parseSites(await accountRequest("GET", "/api/v1/work/sites"));
}

// ---- cloud ----

export interface CloudBucket {
  readonly name: string;
  readonly usedBytes: number;
}

export interface CloudUsage {
  readonly usedBytes: number;
  readonly quotaBytes: number;
  readonly buckets: number;
  /** The account's buckets by name, biggest first. */
  readonly bucketList: ReadonlyArray<CloudBucket>;
}

export function parseCloudUsage(raw: unknown): CloudUsage {
  const r = rec(raw) ?? {};
  const storage = rec(r["storage"]);
  const buckets = list(r["buckets"]);
  const summed = buckets.reduce<number>((sum, b) => sum + num(rec(b)?.["used_bytes"]), 0);
  const bucketList = buckets
    .flatMap((b): CloudBucket[] => {
      const name = str(rec(b)?.["name"]);
      return name ? [{ name, usedBytes: num(rec(b)?.["used_bytes"]) }] : [];
    })
    .toSorted((a, b) => b.usedBytes - a.usedBytes);
  return {
    usedBytes: storage ? num(storage["used_bytes"]) : summed,
    quotaBytes: num(storage?.["quota_bytes"]),
    buckets: buckets.length,
    bucketList,
  };
}

export async function fetchCloudUsage(): Promise<CloudUsage> {
  return parseCloudUsage(await accountRequest("GET", "/api/v1/buckets"));
}

// ---- payments ----

export interface PaymentRow {
  readonly key: string;
  /** Money in (a top-up) or money out (a plan, a computer, AI credits…). */
  readonly direction: "in" | "out";
  readonly amountUsd: number;
  readonly title: string;
  readonly status: string | null;
  readonly at: string;
}

/**
 * Charges of the other product on the same balance (getuno.xyz: SMS numbers,
 * VPS, proxies) — not part of Uno. `/pay/spending` labels them by category.
 */
const OTHER_PRODUCT_CATEGORIES = new Set(["sms", "vps", "isp_proxy", "proxy"]);

const METHOD_LABEL: Record<string, string> = {
  direct: "USDT (TRC-20)",
  nowpayments: "Crypto",
  yookassa: "Card (RUB)",
};

export function parsePayments(history: unknown, spending: unknown): ReadonlyArray<PaymentRow> {
  const rows: PaymentRow[] = [];
  for (const item of list(history, "payments")) {
    const p = rec(item);
    if (!p) continue;
    const status = str(p["status"]);
    // An unpaid invoice that expired is noise in a history of money.
    if (status === "expired") continue;
    const method = str(p["payment_method"]);
    rows.push({
      key: `in-${str(p["order_id"]) || rows.length}`,
      direction: "in",
      amountUsd: Math.abs(num(p["amount"])),
      title: `Added money · ${METHOD_LABEL[method] ?? "Payment"}`,
      status: status || null,
      at: str(p["completed_at"]) || str(p["created_at"]),
    });
  }
  let index = 0;
  for (const item of list(spending, "spending")) {
    const s = rec(item);
    if (!s || OTHER_PRODUCT_CATEGORIES.has(str(s["category"]))) continue;
    index += 1;
    rows.push({
      key: `out-${index}-${str(s["created_at"])}`,
      direction: "out",
      amountUsd: Math.abs(num(s["amount"])),
      title: str(s["description"]) || str(s["category"]) || "Charge",
      status: null,
      at: str(s["created_at"]),
    });
  }
  // A metered cent that rounds to $0 is not a payment a person looks for.
  return rows
    .filter((row) => row.at && row.amountUsd >= 0.005)
    .toSorted((a, b) => b.at.localeCompare(a.at));
}

export async function fetchPayments(): Promise<ReadonlyArray<PaymentRow>> {
  const [history, spending] = await Promise.all([
    accountRequest("GET", "/pay/history").catch(() => null),
    accountRequest("GET", "/pay/spending").catch(() => null),
  ]);
  if (history === null && spending === null) {
    throw new ControlPlaneHttpError(503, "Payment history is not available right now.");
  }
  return parsePayments(history, spending);
}

// ---- console links (money moves there) ----

export const consoleLinks = {
  addMoney: `${CONSOLE_URL}/billing?tab=payments`,
  plans: `${CONSOLE_URL}/billing`,
  plan: (slug: string) => `${CONSOLE_URL}/billing?plan=${encodeURIComponent(slug)}`,
  sites: `${CONSOLE_URL}/sites`,
  apiKeys: `${CONSOLE_URL}/settings`,
  computer: (id: number) => `${CONSOLE_URL}/boxes/${id}`,
};
