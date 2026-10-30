/**
 * The console's project teams, from the interface: managing people is the
 * person's own act, so these go with their sign-in (`accountRequest`), never
 * through a daemon, whose machine key can't and shouldn't do it.
 *
 * @module projectSync/projectTeam.api
 */
import { accountRequest, accountTransport } from "../../account/unoAccount";
import { teamErrorCode, type TeamCard, type TeamList } from "./projectTeam.logic";

const ROOT = "/api/v1/work/team";

/** The teams and invitations; null when teams aren't on for this account. */
export async function loadTeams(): Promise<TeamList | null> {
  if (accountTransport() === "none") return null;
  try {
    return (await accountRequest("GET", `${ROOT}/projects`)) as TeamList;
  } catch (error) {
    if (teamErrorCode(error) === "WORK_TEAM_DISABLED") return null;
    throw error;
  }
}

export const startTeam = (name: string) =>
  accountRequest("POST", `${ROOT}/projects`, { name }) as Promise<TeamCard>;

export const loadTeam = (id: number) =>
  accountRequest("GET", `${ROOT}/projects/${id}`) as Promise<TeamCard>;

export const invite = (id: number, email: string) =>
  accountRequest("POST", `${ROOT}/projects/${id}/invites`, { email });

export const cancelInvite = (id: number, inviteId: number) =>
  accountRequest("DELETE", `${ROOT}/projects/${id}/invites/${inviteId}`);

export const acceptInvite = (inviteId: number) =>
  accountRequest("POST", `${ROOT}/invites/${inviteId}/accept`);

export const declineInvite = (inviteId: number) =>
  accountRequest("POST", `${ROOT}/invites/${inviteId}/decline`);

export const removeMember = (id: number, userId: number) =>
  accountRequest("DELETE", `${ROOT}/projects/${id}/members/${userId}`) as Promise<{
    readonly keys_to_rotate?: ReadonlyArray<string>;
  }>;

export const setMemberKeys = (id: number, userId: number, names: ReadonlyArray<string>) =>
  accountRequest("PUT", `${ROOT}/projects/${id}/members/${userId}/secrets`, { names });
