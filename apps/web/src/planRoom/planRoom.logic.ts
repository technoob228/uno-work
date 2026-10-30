/**
 * "Where is there room on my AI plans?" — one person, several computers,
 * each with its own Claude / ChatGPT sign-in (Home's "AI plan limits",
 * `uno.computer.planLimits`). Upstream T3 Code has the same idea in three
 * places, ported here as plain rules for people who aren't developers:
 *
 * - pooled limits per provider across accounts and environments
 *   (b273d1cfe9 #10300; the same account on two machines counts once,
 *   780b62dd26 / b34ff8f564) → {@link poolPlans};
 * - a fallback when the default provider is out of usage (861a51a6c4
 *   #26164, `exhaustedUsageWindow` / `resolveNewThreadModelSelection`) →
 *   {@link planAtLimit} / {@link pickComputerForNewChat};
 * - new threads balanced across connected machines (420fd76f60 #9895,
 *   `chooseLoadBalancedEnvironment`) — here by the room left on the plan,
 *   not CPU: what runs out for a person is the plan, not the machine.
 *
 * T3 deliberately does NOT switch between several accounts of one provider
 * on one machine (their FAQ: an auto-switcher risks the providers' terms).
 * Uno Work doesn't either: one sign-in per provider per computer, and "move
 * the chat to the computer whose plan has room" is a suggestion by default
 * (`planLimitSwitch: "ask"`).
 *
 * Pure, so the rules are unit-tested without React (planRoom.logic.test.ts).
 */
import type { EnvironmentId, PlanLimitsAccount, PlanLimitsWindow } from "@t3tools/contracts";

export type PlanProvider = PlanLimitsAccount["provider"];

/** The plan a harness runs on when signed in with the person's own account. */
const PLAN_PROVIDER_BY_DRIVER: Readonly<Record<string, PlanProvider>> = {
  claudeAgent: "claude",
  codex: "chatgpt",
};

/** The harness a plan belongs to, the other way round. */
export const DRIVER_BY_PLAN_PROVIDER: Readonly<Record<PlanProvider, string>> = {
  claude: "claudeAgent",
  chatgpt: "codex",
};

export const PLAN_PROVIDER_NAME: Readonly<Record<PlanProvider, string>> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

/** Null for a harness without a plan of its own (Uno AI, OpenCode, Hermes…). */
export function planProviderForDriver(driver: string | null | undefined): PlanProvider | null {
  return driver ? (PLAN_PROVIDER_BY_DRIVER[driver] ?? null) : null;
}

/** Extra usage (pay-as-you-go spend) isn't a wall: the plan itself still runs. */
function blocksWork(window: PlanLimitsWindow): boolean {
  return window.id !== "monthly_spend";
}

function resetMs(window: PlanLimitsWindow): number | null {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** A window whose reset already passed is empty again, whatever the old number says. */
function usedNow(window: PlanLimitsWindow, now: number): number {
  const at = resetMs(window);
  return at !== null && at <= now ? 0 : window.usedPercent;
}

export interface PlanLimitHit {
  readonly window: PlanLimitsWindow;
  /** When work can go on: the latest reset among the full windows (null: not said). */
  readonly resetsAt: string | null;
}

/**
 * Is this account at its limit now (upstream `exhaustedUsageWindow`)? Every
 * window at 100% that hasn't reset yet; work goes on when the last of them
 * resets — a full weekly window outlasts a full 5-hour one.
 */
export function planAtLimit(account: PlanLimitsAccount, now: number): PlanLimitHit | null {
  const full = account.windows.filter(
    (window) => blocksWork(window) && usedNow(window, now) >= 100,
  );
  if (full.length === 0) return null;
  let latest: PlanLimitsWindow | null = null;
  for (const window of full) {
    const at = resetMs(window);
    if (at === null) continue;
    if (latest === null || at > (resetMs(latest) ?? 0)) latest = window;
  }
  const window = latest ?? full[0]!;
  return { window, resetsAt: latest?.resetsAt ?? null };
}

/**
 * Room left on the account now, 0–100: what the fullest window has left (a
 * plan stops at its first wall). Null when there are no numbers at all.
 */
export function planRoomPercent(account: PlanLimitsAccount, now: number): number | null {
  const windows = account.windows.filter(blocksWork);
  if (windows.length === 0) return null;
  const fullest = Math.max(...windows.map((window) => usedNow(window, now)));
  return Math.max(0, Math.min(100, Math.round(100 - fullest)));
}

/** One computer as these rules see it. `accounts: null` — not read (yet), or can't read. */
export interface PlanComputer {
  readonly environmentId: EnvironmentId;
  readonly name: string;
  readonly connected: boolean;
  readonly accounts: ReadonlyArray<PlanLimitsAccount> | null;
}

/**
 * Two computers signed in to the same account share one bucket (upstream
 * dedupes by `driver:email`). Without an email (`claude:default`) we can't
 * tell, so they count as different — the numbers then decide.
 */
function sameAccount(a: PlanLimitsAccount, b: PlanLimitsAccount): boolean {
  return a.id === b.id && !a.id.endsWith(":default");
}

export function planAccountName(account: PlanLimitsAccount): string {
  const name = PLAN_PROVIDER_NAME[account.provider];
  return account.plan ? `${name} ${account.plan}` : name;
}

export interface PlanAlternative {
  readonly environmentId: EnvironmentId;
  readonly computerName: string;
  readonly account: PlanLimitsAccount;
  readonly roomPercent: number;
}

export type NewChatPlanRoom =
  /** No plan of its own (Uno AI, OpenCode…), or this computer has room / no numbers. */
  | { readonly kind: "ok" }
  | {
      readonly kind: "full";
      readonly provider: PlanProvider;
      readonly computerName: string;
      readonly account: PlanLimitsAccount;
      readonly resetsAt: string | null;
      /** Another computer whose own sign-in to the same provider has room; null — none. */
      readonly alternative: PlanAlternative | null;
    };

/**
 * The connected computer (not the current one) whose own sign-in to
 * `provider` — a different account from `blocked` — has the most room now.
 */
function findAlternative(input: {
  readonly currentEnvironmentId: EnvironmentId;
  readonly provider: PlanProvider;
  readonly blocked: PlanLimitsAccount | null;
  readonly computers: ReadonlyArray<PlanComputer>;
  readonly now: number;
}): PlanAlternative | null {
  let best: PlanAlternative | null = null;
  for (const computer of input.computers) {
    if (computer.environmentId === input.currentEnvironmentId || !computer.connected) continue;
    const account = computer.accounts?.find((candidate) => candidate.provider === input.provider);
    if (!account || planAtLimit(account, input.now)) continue;
    if (input.blocked && sameAccount(account, input.blocked)) continue;
    // No numbers (a fresh sign-in): room is likely, but less sure than a known number.
    const roomPercent = planRoomPercent(account, input.now) ?? 1;
    if (best === null || roomPercent > best.roomPercent) {
      best = {
        environmentId: computer.environmentId,
        computerName: computer.name,
        account,
        roomPercent,
      };
    }
  }
  return best;
}

/**
 * Where should a new chat for `provider` start (upstream fallback + load
 * balancing, by plan room)? "ok" when this computer's plan has room (or we
 * don't know — never guess a wall). When it's at its limit: the connected
 * computer whose own, different account of the same provider has the most
 * room — or none.
 */
export function pickComputerForNewChat(input: {
  readonly currentEnvironmentId: EnvironmentId;
  readonly provider: PlanProvider | null;
  readonly computers: ReadonlyArray<PlanComputer>;
  readonly now: number;
}): NewChatPlanRoom {
  const { provider, now } = input;
  if (provider === null) return { kind: "ok" };
  const current = input.computers.find(
    (computer) => computer.environmentId === input.currentEnvironmentId,
  );
  const blocked = current?.accounts?.find((account) => account.provider === provider);
  if (!current || !blocked) return { kind: "ok" };
  const hit = planAtLimit(blocked, now);
  if (!hit) return { kind: "ok" };

  const best = findAlternative({
    currentEnvironmentId: current.environmentId,
    provider,
    blocked,
    computers: input.computers,
    now,
  });
  return {
    kind: "full",
    provider,
    computerName: current.name,
    account: blocked,
    resetsAt: hit.resetsAt,
    alternative: best,
  };
}

// ── Pooled view (Settings → AI → "Your AI plans") ─────────────────────

export interface PooledPlanAccount {
  readonly account: PlanLimitsAccount;
  /** Every computer signed in to it, in the order given. */
  readonly computers: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly name: string;
  }>;
  readonly hit: PlanLimitHit | null;
  readonly roomPercent: number | null;
}

export interface PooledPlan {
  readonly provider: PlanProvider;
  readonly accounts: ReadonlyArray<PooledPlanAccount>;
  /** Accounts with room now (not at their limit). */
  readonly withRoom: number;
  /** The earliest moment an account at its limit comes back; null — none is, or not said. */
  readonly nextResetAt: string | null;
}

function checkedMs(account: PlanLimitsAccount): number {
  const at = account.checkedAt ? Date.parse(account.checkedAt) : Number.NaN;
  return Number.isFinite(at) ? at : 0;
}

/**
 * Every plan across the computers, one entry per distinct account (the
 * freshest numbers win when two computers report the same one), grouped by
 * provider — Claude first. Upstream pools a percentage across accounts; here
 * plans of different sizes (Max 20x and Pro) stay separate rows with one
 * plain sum on top: "room on 1 of 2".
 */
export function poolPlans(
  computers: ReadonlyArray<PlanComputer>,
  now: number,
): ReadonlyArray<PooledPlan> {
  const byKey = new Map<
    string,
    { account: PlanLimitsAccount; computers: Array<{ environmentId: EnvironmentId; name: string }> }
  >();
  for (const computer of computers) {
    for (const account of computer.accounts ?? []) {
      const key = account.id.endsWith(":default")
        ? `${computer.environmentId}:${account.id}`
        : account.id;
      const seen = byKey.get(key);
      const where = { environmentId: computer.environmentId, name: computer.name };
      if (!seen) {
        byKey.set(key, { account, computers: [where] });
        continue;
      }
      seen.computers.push(where);
      if (checkedMs(account) > checkedMs(seen.account) && account.windows.length > 0) {
        seen.account = account;
      }
    }
  }
  const providers: PlanProvider[] = ["claude", "chatgpt"];
  return providers.flatMap((provider): PooledPlan[] => {
    const accounts = [...byKey.values()]
      .filter((entry) => entry.account.provider === provider)
      .map(
        (entry): PooledPlanAccount => ({
          account: entry.account,
          computers: entry.computers,
          hit: planAtLimit(entry.account, now),
          roomPercent: planRoomPercent(entry.account, now),
        }),
      );
    if (accounts.length === 0) return [];
    const resets = accounts
      .map((entry) => (entry.hit?.resetsAt ? Date.parse(entry.hit.resetsAt) : Number.NaN))
      .filter(Number.isFinite);
    return [
      {
        provider,
        accounts,
        withRoom: accounts.filter((entry) => entry.hit === null).length,
        nextResetAt: resets.length > 0 ? new Date(Math.min(...resets)).toISOString() : null,
      },
    ];
  });
}

// ── A chat that stopped at the plan's limit ───────────────────────────

/**
 * The CLIs' own words when the plan is out (Claude Code: "You've hit your
 * limit · resets 3pm", "5-hour limit reached ∙ resets 3pm", older "Claude AI
 * usage limit reached|<unix>"; Codex: "You've hit your usage limit … try
 * again at 3:05 PM"). Not "approaching the limit" warnings, not the Uno
 * gateway's own "busy" (turnErrorRetry).
 */
const PLAN_LIMIT_PATTERNS: ReadonlyArray<RegExp> = [
  /\busage[ _]limit[ _]reached\b/i,
  /\bhit your (?:\w+[ -])?limit\b/i,
  /\b(?:5-hour|five-hour|session|weekly|opus|sonnet|daily|monthly) limit reached\b/i,
  /\bout of (?:extra )?usage\b/i,
];
const NOT_YET = /\bapproaching\b|\bnearing\b|\bclose to\b/i;

/** Texts this long are an answer that mentions limits, not the CLI's stop line. */
const MAX_LIMIT_LINE = 600;

export function isPlanLimitText(text: string | null | undefined): boolean {
  if (!text || text.length > MAX_LIMIT_LINE) return false;
  if (NOT_YET.test(text)) return false;
  return PLAN_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

const HOUR_MS = 60 * 60_000;

/**
 * When the stop line says work resumes: `|<unix seconds>`, "in 2 hours 5
 * minutes", or "resets 3pm" / "try again at 3:05 PM" (the next such time,
 * in this browser's time zone — the CLI's own zone in brackets is ignored).
 * Null when it doesn't say.
 */
export function planLimitResetFromText(text: string, now: number): string | null {
  const epoch = /\|\s*(\d{10,13})\b/.exec(text);
  if (epoch?.[1]) {
    const raw = Number(epoch[1]);
    const at = raw > 1e12 ? raw : raw * 1000;
    if (at > now) return new Date(at).toISOString();
  }
  const relative = /\b(?:try again|resets?|available again)\s+in\s+([^.;)]+)/i.exec(text);
  if (relative?.[1]) {
    let total = 0;
    for (const match of relative[1].matchAll(
      /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi,
    )) {
      const amount = Number(match[1]);
      const unit = (match[2] ?? "").toLowerCase();
      if (unit.startsWith("d")) total += amount * 24 * HOUR_MS;
      else if (unit.startsWith("h")) total += amount * HOUR_MS;
      else total += amount * 60_000;
    }
    if (total > 0) return new Date(now + total).toISOString();
  }
  const clock =
    /\b(?:resets?|try again at|available again at)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(
      text,
    );
  if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = clock[2] ? Number(clock[2]) : 0;
    const meridiem = clock[3]!.toLowerCase();
    if (hour >= 1 && hour <= 12 && minute <= 59) {
      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.toISOString();
    }
  }
  return null;
}

export interface ChatPlanLimit {
  readonly provider: PlanProvider;
  readonly computerName: string;
  /** From the computer's plan numbers first, else from the stop line. */
  readonly resetsAt: string | null;
  readonly alternative: PlanAlternative | null;
}

/**
 * Did this chat stop because its plan ran out, and where can it go on? The
 * signal is the stop line (the turn's error, or — Claude Code reports the
 * limit as a short "answer" and a finished turn — the last reply), checked
 * against the chat's harness: Uno AI's own "busy" is not a plan.
 */
export function chatPlanLimit(input: {
  readonly driver: string | null;
  readonly stopText: string | null;
  /** When the chat stopped (the turn's end); the stop line's "3pm" is read from then. */
  readonly stoppedAt?: string | null;
  readonly currentEnvironmentId: EnvironmentId;
  readonly computers: ReadonlyArray<PlanComputer>;
  readonly now: number;
}): ChatPlanLimit | null {
  const provider = planProviderForDriver(input.driver);
  if (provider === null || !isPlanLimitText(input.stopText)) return null;
  const stoppedMs = input.stoppedAt ? Date.parse(input.stoppedAt) : Number.NaN;
  const stopped = Number.isFinite(stoppedMs) ? stoppedMs : input.now;
  const textReset = planLimitResetFromText(input.stopText!, stopped);
  const room = pickComputerForNewChat({
    currentEnvironmentId: input.currentEnvironmentId,
    provider,
    computers: input.computers,
    now: input.now,
  });
  if (room.kind === "full") {
    return {
      provider,
      computerName: room.computerName,
      resetsAt: room.resetsAt ?? textReset,
      alternative: room.alternative,
    };
  }
  const here = input.computers.find(
    (computer) => computer.environmentId === input.currentEnvironmentId,
  );
  const hereAccount = here?.accounts?.find((account) => account.provider === provider) ?? null;
  // The plan is back: numbers read after the stop say there's room, or the
  // reset the stop line named has passed, or (saying nothing) a 5-hour window has.
  const readAfterStop = hereAccount?.checkedAt
    ? Date.parse(hereAccount.checkedAt) > stopped
    : false;
  if (hereAccount && readAfterStop && planAtLimit(hereAccount, input.now) === null) return null;
  if (textReset !== null && Date.parse(textReset) <= input.now) return null;
  if (textReset === null && input.now - stopped >= 5 * HOUR_MS) return null;
  // The numbers here are older than the stop (5-minute cache): trust the
  // stop line, and still look for a computer with room.
  return {
    provider,
    computerName: here?.name ?? "this computer",
    resetsAt: textReset,
    alternative: findAlternative({
      currentEnvironmentId: input.currentEnvironmentId,
      provider,
      blocked: hereAccount,
      computers: input.computers,
      now: input.now,
    }),
  };
}

// ── Words ─────────────────────────────────────────────────────────────

/** "3:00 PM" today, "Fri 3:00 PM" this week, "Nov 3, 3:00 PM" later. */
export function planUntilText(
  resetsAt: string | null,
  now: number,
  format: { readonly locale?: string; readonly timeZone?: string } = {},
): string | null {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  const base: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  };
  const sameDay =
    new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone: format.timeZone }).format(
      at,
    ) ===
    new Intl.DateTimeFormat("en-CA", { dateStyle: "short", timeZone: format.timeZone }).format(now);
  if (sameDay) return new Intl.DateTimeFormat(format.locale, base).format(at);
  const options: Intl.DateTimeFormatOptions =
    at - now < 6 * 24 * HOUR_MS
      ? { ...base, weekday: "short" }
      : { ...base, month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(format.locale, options).format(at);
}

/** "Claude on uno-work is at its limit until 3:00 PM." */
export function planFullLine(input: {
  readonly provider: PlanProvider;
  readonly computerName: string;
  readonly resetsAt: string | null;
  readonly now: number;
  readonly format?: { readonly locale?: string; readonly timeZone?: string };
}): string {
  const until = planUntilText(input.resetsAt, input.now, input.format);
  const name = PLAN_PROVIDER_NAME[input.provider];
  return until
    ? `${name} on ${input.computerName} is at its limit until ${until}.`
    : `${name} on ${input.computerName} is at its limit for now.`;
}

/** "Started on MacBook — Claude on uno-work is at its limit until 3:00 PM." */
export function planStartedOnLine(input: {
  readonly startedOn: string;
  readonly provider: PlanProvider;
  readonly blockedComputerName: string;
  readonly resetsAt: string | null;
  readonly now: number;
  readonly format?: { readonly locale?: string; readonly timeZone?: string };
}): string {
  const full = planFullLine({
    provider: input.provider,
    computerName: input.blockedComputerName,
    resetsAt: input.resetsAt,
    now: input.now,
    ...(input.format ? { format: input.format } : {}),
  });
  return `Started on ${input.startedOn} — ${full}`;
}
