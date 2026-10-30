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
 * Uno Work doesn't either: a second account on a computer (Settings → AI →
 * "Use more than one account", off by default) is used only by a button
 * ({@link otherAccountWithRoom}) and is never a target of "Switch by itself",
 * which moves a new chat only between the person's computers, to their main
 * sign-ins. That move is a suggestion by default (`planLimitSwitch: "ask"`).
 *
 * Pure, so the rules are unit-tested without React (planRoom.logic.test.ts).
 */
import type { EnvironmentId, PlanLimitsAccount } from "@t3tools/contracts";
import {
  blocksWork,
  isPlanLimitText,
  planAtLimit,
  planAccountForInstance,
  planLimitResetFromText,
  planProviderForDriver,
  DRIVER_BY_PLAN_PROVIDER,
  usedNow,
  type PlanLimitHit,
  type PlanProvider,
} from "@t3tools/shared/planLimitRules";

export {
  DRIVER_BY_PLAN_PROVIDER,
  isPlanLimitText,
  pendingPlanResume,
  planAtLimit,
  planLimitResetFromText,
  planProviderForDriver,
  type PlanLimitHit,
  type PlanProvider,
} from "@t3tools/shared/planLimitRules";

const HOUR_MS = 60 * 60_000;

export const PLAN_PROVIDER_NAME: Readonly<Record<PlanProvider, string>> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
};

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
    // Its main sign-in only: a second account is used by a button, never by a move.
    const account = planAccountForInstance(computer.accounts ?? [], input.provider, null);
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
  /** The provider instance picked: a second account has limits of its own. */
  readonly instanceId?: string | null | undefined;
  readonly computers: ReadonlyArray<PlanComputer>;
  readonly now: number;
}): NewChatPlanRoom {
  const { provider, now } = input;
  if (provider === null) return { kind: "ok" };
  const current = input.computers.find(
    (computer) => computer.environmentId === input.currentEnvironmentId,
  );
  const blocked = planAccountForInstance(current?.accounts ?? [], provider, input.instanceId);
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

export interface OtherAccount {
  readonly instanceId: string;
  readonly account: PlanLimitsAccount;
  readonly roomPercent: number;
}

/**
 * Another account of `provider` signed in on this computer, with room now:
 * the one with the most. What "Continue with <account>" offers; nothing here
 * ever acts on it by itself.
 */
export function otherAccountWithRoom(input: {
  readonly accounts: ReadonlyArray<PlanLimitsAccount> | null;
  readonly provider: PlanProvider;
  readonly blocked: PlanLimitsAccount | null;
  readonly now: number;
}): OtherAccount | null {
  let best: OtherAccount | null = null;
  for (const account of input.accounts ?? []) {
    if (account.provider !== input.provider || planAtLimit(account, input.now)) continue;
    if (input.blocked && account.id === input.blocked.id) continue;
    const roomPercent = planRoomPercent(account, input.now) ?? 1;
    if (best === null || roomPercent > best.roomPercent) {
      best = {
        instanceId: account.instanceId ?? DRIVER_BY_PLAN_PROVIDER[input.provider],
        account,
        roomPercent,
      };
    }
  }
  return best;
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

export interface ChatPlanLimit {
  readonly provider: PlanProvider;
  readonly computerName: string;
  /** From the computer's plan numbers first, else from the stop line. */
  readonly resetsAt: string | null;
  readonly alternative: PlanAlternative | null;
  /** Another account on this computer with room: "Continue with <account>". */
  readonly otherAccount: OtherAccount | null;
}

/**
 * Did this chat stop because its plan ran out, and where can it go on? The
 * signal is the stop line (the turn's error, or — Claude Code reports the
 * limit as a short "answer" and a finished turn — the last reply), checked
 * against the chat's harness: Uno AI's own "busy" is not a plan.
 */
export function chatPlanLimit(input: {
  readonly driver: string | null;
  /** The provider instance the chat runs on: a second account has limits of its own. */
  readonly instanceId?: string | null | undefined;
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
    instanceId: input.instanceId,
    computers: input.computers,
    now: input.now,
  });
  const here = input.computers.find(
    (computer) => computer.environmentId === input.currentEnvironmentId,
  );
  const hereAccount = planAccountForInstance(here?.accounts ?? [], provider, input.instanceId);
  const otherAccount = otherAccountWithRoom({
    accounts: here?.accounts ?? null,
    provider,
    blocked: hereAccount,
    now: input.now,
  });
  if (room.kind === "full") {
    return {
      provider,
      computerName: room.computerName,
      resetsAt: room.resetsAt ?? textReset,
      alternative: room.alternative,
      otherAccount,
    };
  }
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
    otherAccount,
  };
}

// ── Words ─────────────────────────────────────────────────────────────

/** "Resumes at 3:00 PM" / "Resumes Fri 3:00 PM"; null once the time has passed. */
export function planResumeLine(
  resumeAt: string,
  now: number,
  format: { readonly locale?: string; readonly timeZone?: string } = {},
): string | null {
  const until = planUntilText(resumeAt, now, format);
  if (until === null) return null;
  return /^\d/.test(until) ? `Resumes at ${until}` : `Resumes ${until}`;
}

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
