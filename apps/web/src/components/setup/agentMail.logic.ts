/**
 * "Email for your AI" in Connectors: the rules of the row and of its
 * "Change name" dialog. The console checks the name again (and whether it is
 * free); these only save a round trip and say the rule in plain words.
 * Rules: reports/day_2026-10-20/agent-mail/SPEC.md, "Адрес".
 */
import type { AgentMailState } from "../../lib/setupApi";

export const AGENT_MAIL_DEFAULT_DOMAIN = "uno4.me";

const LOCAL_PATTERN = /^[a-z0-9][a-z0-9.-]{2,39}$/;

/** Names that belong to Uno or to mail itself (the console has the same list). */
export const AGENT_MAIL_RESERVED: ReadonlySet<string> = new Set([
  "admin",
  "postmaster",
  "abuse",
  "hostmaster",
  "webmaster",
  "support",
  "help",
  "hello",
  "info",
  "noreply",
  "no-reply",
  "security",
  "billing",
  "root",
  "www",
  "mail",
  "uno",
  "team",
  "sales",
  "legal",
  "privacy",
  "dmarc",
]);

export const AGENT_MAIL_NAME_HINT =
  "3–40 characters: lowercase letters, digits, dots and dashes. Starts with a letter or digit.";

/** What the person typed, as the address will have it. */
export function normalizeAgentMailLocal(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Why this name can't be used, in one sentence; null when it can. */
export function agentMailLocalProblem(raw: string): string | null {
  const local = normalizeAgentMailLocal(raw);
  if (local.length === 0) return "Type a name.";
  if (local.length < 3) return "At least 3 characters.";
  if (local.length > 40) return "At most 40 characters.";
  if (!/^[a-z0-9]/.test(local)) return "Start with a letter or a digit.";
  if (!LOCAL_PATTERN.test(local)) return "Only lowercase letters, digits, dots and dashes.";
  if (local.includes("--")) return "No two dashes in a row.";
  if (AGENT_MAIL_RESERVED.has(local)) return "This name is reserved. Try another one.";
  return null;
}

/** `uno4.me` from the current address (the console decides the domain). */
export function agentMailDomain(address: string | null | undefined): string {
  const at = address?.lastIndexOf("@") ?? -1;
  const domain = at >= 0 ? address!.slice(at + 1).trim() : "";
  return domain.length > 0 ? domain : AGENT_MAIL_DEFAULT_DOMAIN;
}

/** `<local>@uno4.me` for the dialog's preview; the placeholder while empty. */
export function agentMailPreview(raw: string, domain: string): string {
  const local = normalizeAgentMailLocal(raw);
  return `${local.length > 0 ? local : "name"}@${domain}`;
}

/** The row shows only for a mailbox the console reports (flag on, cloud computer). */
export function agentMailRowVisible(
  state: AgentMailState | undefined,
): state is AgentMailState & { readonly mailbox: NonNullable<AgentMailState["mailbox"]> } {
  return state?.available === true && state.mailbox !== null && state.mailbox.address.length > 0;
}

/** A failed rename → the dialog's line. The daemon puts the person's sentence in the message. */
export function agentMailChangeError(error: unknown): string {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { readonly status: unknown }).status
      : undefined;
  const message = error instanceof Error ? error.message.trim() : "";
  if (status === 409) return message || "This name is taken. Try another one.";
  if (status === 422) return message || AGENT_MAIL_NAME_HINT;
  if (status === 429) return message || "Too many changes. Try again later.";
  return message.length > 0 && !message.startsWith("Request failed with status")
    ? message
    : "Couldn't change the name. Try again.";
}
