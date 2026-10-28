/**
 * An assistant's own mail (decisions 20.10, 22.10): the console keeps ONE
 * mailbox per computer (`name-otter@uno4.me`); each assistant on it gets its
 * own address in that mailbox — the plus form `name-otter+scout@uno4.me`,
 * which the console already delivers to the same mailbox — and its own
 * rules: on or off, who it may write to, a daily limit of its own.
 *
 * Uno (the computer's own assistant) has the mailbox's plain address and
 * sees all of it; another assistant sees letters to its own address and the
 * ones it sent. Work checks the rules on every `mail_*` call of an
 * assistant's chats (`unoWork/mailTools.ts`), the page and the setup show
 * them. Pure: no I/O, shared by the daemon and the UI so the two can't drift.
 */
import {
  ASSISTANT_MAIL_ALLOW_MAX,
  ASSISTANT_MAIL_DAILY_MAX,
  ASSISTANT_PROJECT_ID,
  ASSISTANT_PROJECT_ID_PREFIX,
  type AssistantMailPolicy,
  type AssistantMailPolicyPatch,
  type AssistantMailRecipients,
} from "@t3tools/contracts";

export const DEFAULT_ASSISTANT_MAIL_POLICY: AssistantMailPolicy = {
  enabled: true,
  // Misha 20.10: the agent writes to anyone, with a daily limit.
  recipients: "anyone",
  allow: [],
  dailyLimit: ASSISTANT_MAIL_DAILY_MAX,
};

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** A plain address, lowercased; null when it isn't one. */
export function normalizeMailAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return value.length <= 254 && ADDRESS.test(value) ? value : null;
}

function addresses(raw: unknown): ReadonlyArray<string> {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    const address = normalizeMailAddress(item);
    if (address !== null) out.add(address);
    if (out.size >= ASSISTANT_MAIL_ALLOW_MAX) break;
  }
  return [...out];
}

const RECIPIENTS: ReadonlySet<string> = new Set(["anyone", "owner", "list"]);

function clampLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(ASSISTANT_MAIL_DAILY_MAX, Math.floor(raw)));
}

/** Whatever is on disk (nothing, an older shape, a hand edit) as today's rules. */
export function normalizeMailPolicy(raw: unknown): AssistantMailPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_ASSISTANT_MAIL_POLICY;
  }
  const record = raw as Record<string, unknown>;
  return {
    enabled: typeof record.enabled === "boolean" ? record.enabled : true,
    recipients:
      typeof record.recipients === "string" && RECIPIENTS.has(record.recipients)
        ? (record.recipients as AssistantMailRecipients)
        : "anyone",
    allow: addresses(record.allow),
    dailyLimit: clampLimit(record.dailyLimit, ASSISTANT_MAIL_DAILY_MAX),
  };
}

/** The rules with a change applied (addresses cleaned, the limit clamped). */
export function applyMailPatch(
  policy: AssistantMailPolicy,
  patch: AssistantMailPolicyPatch,
): AssistantMailPolicy {
  return normalizeMailPolicy({
    ...policy,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.recipients !== undefined ? { recipients: patch.recipients } : {}),
    ...(patch.allow !== undefined ? { allow: patch.allow } : {}),
    ...(patch.dailyLimit !== undefined ? { dailyLimit: patch.dailyLimit } : {}),
  });
}

const RECIPIENTS_RANK: Readonly<Record<AssistantMailRecipients, number>> = {
  owner: 0,
  list: 1,
  anyone: 2,
};

/**
 * What `next` would allow beyond `current`, in plain words (empty = the same
 * or narrower). An assistant saving its own setup only narrows its mail.
 */
export function mailPolicyBeyond(
  current: AssistantMailPolicy,
  next: AssistantMailPolicy,
): ReadonlyArray<string> {
  const beyond: string[] = [];
  if (next.enabled && !current.enabled) beyond.push("its mail switched on");
  if (!next.enabled) return beyond;
  if (RECIPIENTS_RANK[next.recipients] > RECIPIENTS_RANK[current.recipients]) {
    beyond.push(
      next.recipients === "anyone" ? "mail to anyone" : "mail to addresses beyond the person",
    );
  } else if (next.recipients === "list" && current.recipients === "list") {
    const allowed = new Set(current.allow);
    const extra = next.allow.filter((address) => !allowed.has(address));
    if (extra.length > 0) beyond.push(`mail to ${extra.join(", ")}`);
  }
  if (next.dailyLimit > current.dailyLimit) {
    beyond.push(`${next.dailyLimit} letters a day (now ${current.dailyLimit})`);
  }
  return beyond;
}

/**
 * The part of an assistant's address after `+`: its folder id without
 * `assistant-` (unique on its computer and stable through renames).
 */
export function assistantMailTag(projectId: string): string | null {
  if (projectId === ASSISTANT_PROJECT_ID) return null;
  const bare = projectId.startsWith(ASSISTANT_PROJECT_ID_PREFIX)
    ? projectId.slice(ASSISTANT_PROJECT_ID_PREFIX.length)
    : projectId;
  const tag = bare
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  return tag.length > 0 ? tag : null;
}

/** Its own address in the computer's mailbox: the plain one for Uno, `local+tag@…` for the others. */
export function assistantMailAddress(mailboxAddress: string, projectId: string): string {
  const tag = assistantMailTag(projectId);
  const at = mailboxAddress.indexOf("@");
  if (tag === null || at <= 0) return mailboxAddress;
  const local = mailboxAddress.slice(0, at).split("+")[0];
  return `${local}+${tag}${mailboxAddress.slice(at)}`.toLowerCase();
}

/** The UTC day a letter counts for ("resets at 00:00 UTC", as the console's limit). */
export function mailDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type MailSendDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "off" | "limit" | "no-owner" }
  | { readonly ok: false; readonly reason: "recipients"; readonly refused: ReadonlyArray<string> };

/**
 * May this assistant send this letter now? `ownerEmail`: the person's Uno
 * account address, when known. `sentToday`: its own letters today.
 */
export function mailSendDecision(input: {
  readonly policy: AssistantMailPolicy;
  readonly ownerEmail: string | null;
  readonly recipients: ReadonlyArray<string>;
  readonly sentToday: number;
}): MailSendDecision {
  const { policy } = input;
  if (!policy.enabled) return { ok: false, reason: "off" };
  if (input.sentToday >= policy.dailyLimit) return { ok: false, reason: "limit" };
  if (policy.recipients === "anyone") return { ok: true };
  const owner = normalizeMailAddress(input.ownerEmail);
  if (policy.recipients === "owner" && owner === null) return { ok: false, reason: "no-owner" };
  const allowed = new Set(policy.recipients === "owner" ? [owner!] : policy.allow);
  // The person is always allowed on a list.
  if (owner !== null) allowed.add(owner);
  const refused = input.recipients
    .map((raw) => normalizeMailAddress(raw) ?? String(raw))
    .filter((address) => !allowed.has(address));
  return refused.length === 0 ? { ok: true } : { ok: false, reason: "recipients", refused };
}

/** One line for the page and the assistant's context: "Writes to anyone · up to 50 letters a day". */
export function mailPolicyLine(policy: AssistantMailPolicy, ownerEmail: string | null): string {
  if (!policy.enabled) return "Mail is off";
  const who =
    policy.recipients === "anyone"
      ? "Writes to anyone"
      : policy.recipients === "owner"
        ? `Writes only to you${ownerEmail ? ` (${ownerEmail})` : ""}`
        : policy.allow.length > 0
          ? `Writes only to ${policy.allow.join(", ")}${ownerEmail ? " and you" : ""}`
          : "Writes only to you";
  return policy.dailyLimit === 0
    ? `${who} · sends nothing (limit 0)`
    : `${who} · up to ${policy.dailyLimit} letter${policy.dailyLimit === 1 ? "" : "s"} a day`;
}

/**
 * Is this letter (as `GET /work/mail/messages` lists it) one of this
 * assistant's? Uno's: every letter. Another's: sent to its own address, or
 * one it sent (`sentIds`, Work keeps them).
 */
export function mailBelongsTo(
  message: {
    readonly id: string | null;
    readonly direction: unknown;
    readonly to: unknown;
    readonly cc?: unknown;
  },
  owner: {
    readonly isUno: boolean;
    readonly address: string;
    readonly sentIds: ReadonlySet<string>;
  },
): boolean {
  if (owner.isUno) return true;
  if (message.id !== null && owner.sentIds.has(message.id)) return true;
  if (message.direction === "out") return false;
  const own = owner.address.toLowerCase();
  const listed = [message.to, message.cc].flatMap((value) =>
    Array.isArray(value) ? value : typeof value === "string" ? [value] : [],
  );
  return listed.some((entry) => typeof entry === "string" && entry.toLowerCase().includes(own));
}
