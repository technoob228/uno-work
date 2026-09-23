/**
 * What each computer on the account is FOR — its role — in words a person
 * picks: the Uno Work computer where you work, a server for a VPN or a bot,
 * production, staging, a sandbox.
 *
 * Where the role lives: its own field on the box, `computer_role` (console
 * migration 139; not `role`, which is the control plane's own: standalone /
 * replica / work…). Before that the role rode at the start of the free-form
 * `comment` as a tag — `[production] anything else the person wrote` — and a
 * console that hasn't got the field yet still works that way, so the tag stays
 * the fallback for reading and the way to write there. An Uno Work computer is
 * always "Workspace": that is what it is, not a label.
 *
 * Kept free of React so the parsing is unit-tested.
 */

export type ComputerRole = "workspace" | "server" | "production" | "staging" | "sandbox";

/** Roles a person can give a computer that is not an Uno Work one. */
export const ASSIGNABLE_ROLES: ReadonlyArray<Exclude<ComputerRole, "workspace">> = [
  "server",
  "production",
  "staging",
  "sandbox",
];

/** Every role in the order "Add computer" offers them. */
export const ALL_ROLES: ReadonlyArray<ComputerRole> = ["workspace", ...ASSIGNABLE_ROLES];

export const ROLE_LABEL: Record<ComputerRole, string> = {
  workspace: "Workspace",
  server: "Server",
  production: "Production",
  staging: "Staging",
  sandbox: "Sandbox",
};

export const ROLE_BLURB: Record<ComputerRole, string> = {
  workspace: "Where you work: Uno Work with chats, agents, files and apps.",
  server: "Runs something for you around the clock — a VPN, a bot, a database.",
  production: "The live version your customers use. Changes land here last.",
  staging: "A copy to try changes on before they go to production.",
  sandbox: "For experiments. Safe to break, easy to throw away.",
};

const TAG = /^\s*\[(server|production|staging|sandbox|workspace)\]\s*/i;

export interface ParsedComment {
  /** The tagged role, or null when the comment carries none. */
  readonly role: ComputerRole | null;
  /** The rest of the comment, as the person wrote it. */
  readonly note: string;
}

export function parseRoleComment(comment: string | null | undefined): ParsedComment {
  const text = comment ?? "";
  const match = TAG.exec(text);
  if (!match) return { role: null, note: text.trim() };
  return {
    role: match[1]!.toLowerCase() as ComputerRole,
    note: text.slice(match[0].length).trim(),
  };
}

/** The comment to save when the role changes; the person's own note is kept. */
export function withRole(comment: string | null | undefined, role: ComputerRole): string {
  const { note } = parseRoleComment(comment);
  return note ? `[${role}] ${note}` : `[${role}]`;
}

/** A role as the console sends it in `computer_role`, or null. */
export function parseRoleField(value: unknown): ComputerRole | null {
  if (typeof value !== "string") return null;
  const role = value.trim().toLowerCase();
  return (ALL_ROLES as ReadonlyArray<string>).includes(role) ? (role as ComputerRole) : null;
}

/**
 * The role a computer plays: an Uno Work computer is the workspace; otherwise
 * the console's `computer_role` field; failing that (an older console) the tag
 * in its comment; with neither, a plain server.
 */
export function computerRole(input: {
  readonly workMachine: boolean;
  readonly roleField?: unknown;
  readonly comment: string | null | undefined;
}): ComputerRole {
  if (input.workMachine) return "workspace";
  const role = parseRoleField(input.roleField) ?? parseRoleComment(input.comment).role;
  return role && role !== "workspace" ? role : "server";
}
