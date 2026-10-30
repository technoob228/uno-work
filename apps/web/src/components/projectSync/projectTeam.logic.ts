/**
 * People in a project, in the console's words (`/api/v1/work/team`, see
 * reports TEAM_API.md) and the person's. Pure.
 *
 * @module projectSync/projectTeam.logic
 */

export interface TeamPerson {
  readonly user_id: number;
  readonly email: string | null;
  readonly username: string;
}

export interface TeamProjectRow {
  readonly id: number;
  readonly name: string;
  readonly role: "owner" | "editor";
  readonly owner: TeamPerson;
}

export interface TeamIncomingInvite {
  readonly id: number;
  readonly project_id: number;
  readonly project_name: string;
  readonly owner: TeamPerson;
  readonly expires_at: string;
}

export interface TeamList {
  readonly projects: ReadonlyArray<TeamProjectRow>;
  readonly invites: ReadonlyArray<TeamIncomingInvite>;
}

export interface TeamMember extends TeamPerson {
  readonly role: "owner" | "editor";
  /** Keys given to this person; the owner has them all (no field). */
  readonly secrets?: ReadonlyArray<string>;
}

export interface TeamPendingInvite {
  readonly id: number;
  readonly email: string;
  readonly expires_at: string;
}

export interface TeamCard {
  readonly project: {
    readonly id: number;
    readonly name: string;
    readonly role: "owner" | "editor";
    readonly owner: TeamPerson;
  };
  readonly members: ReadonlyArray<TeamMember>;
  /** Only the owner sees these two. */
  readonly invites?: ReadonlyArray<TeamPendingInvite>;
  readonly secrets?: ReadonlyArray<string>;
}

const MESSAGES: Readonly<Record<string, string>> = {
  ALREADY_MEMBER: "They're already in this project.",
  CANNOT_INVITE_SELF: "That's your own email.",
  CANNOT_REMOVE_OWNER: "The project's owner can't be removed.",
  EMAIL_NOT_VERIFIED: "Confirm your email in your Uno account first.",
  INVALID_EMAIL: "That doesn't look like an email address.",
  INVITE_EMAIL_MISMATCH: "This invitation is for another email address.",
  INVITE_EXPIRED: "This invitation has expired. Ask for a new one.",
  INVITE_NOT_PENDING: "This invitation is no longer open.",
  OWNER_ONLY: "Only the project's owner can do that.",
  STORAGE_QUOTA_EXCEEDED: "The project owner's Uno cloud is full.",
  TEAM_LIMIT: "A project can have up to 20 people, invitations included.",
  UNKNOWN_SECRETS: "One of those keys is no longer in this project.",
  VAULT_NOT_CONFIGURED: "The Uno vault isn't available right now. Try again later.",
};

/** The console's error code, from an error `accountRequest` threw. */
export function teamErrorCode(error: unknown): string | null {
  const body = (error as { body?: unknown } | null)?.body;
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === "string" ? code : null;
}

export function teamErrorMessage(error: unknown): string {
  return MESSAGES[teamErrorCode(error) ?? ""] ?? "That didn't work. Try again in a moment.";
}

/** How a person is called: the name they chose, not the generated `uno_1234`. */
export function personLabel(person: Pick<TeamPerson, "email" | "username">): string {
  const username = person.username?.trim() ?? "";
  if (username && !/^uno_\d+$/.test(username)) return username;
  return person.email ?? username;
}

/**
 * The team of a synced project. `teamId`: the folder works in someone else's
 * project; without it the folder is the person's own, and someone else's
 * project with the same name is another project.
 */
export function teamProjectOf(
  list: TeamList | null | undefined,
  syncName: string,
  teamId?: number | null,
): TeamProjectRow | null {
  const rows = list?.projects ?? [];
  if (teamId !== undefined && teamId !== null) {
    return rows.find((project) => project.id === teamId) ?? null;
  }
  return rows.find((project) => project.name === syncName && project.role === "owner") ?? null;
}

/** The checkboxes' result: a key in or out of the set the console keeps whole. */
export function toggledKeys(
  current: ReadonlyArray<string>,
  name: string,
  on: boolean,
): ReadonlyArray<string> {
  const others = current.filter((item) => item !== name);
  return on ? [...others, name].toSorted() : others;
}

/** After someone leaves: what they could have seen can't be taken back from their computers. */
export function rotateLine(who: string, keys: ReadonlyArray<string>): string {
  const names = keys.join(", ");
  return keys.length === 1
    ? `${who} no longer has access, but the key they had stays on their computers. Change ${names}.`
    : `${who} no longer has access, but the keys they had stay on their computers. Change these: ${names}.`;
}
