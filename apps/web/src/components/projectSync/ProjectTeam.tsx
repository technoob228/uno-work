/**
 * Project settings → People: invite someone by email, tick the keys they
 * get, remove them. Removing can't take keys back from their computers, so
 * it ends with what to change. Shown only when teams are on for the account.
 *
 * @module projectSync/ProjectTeam
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CopyIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { UNO_WORK_URL } from "../../account/unoAccount";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  cancelInvite,
  invite,
  loadTeam,
  loadTeams,
  removeMember,
  setMemberKeys,
  startTeam,
} from "./projectTeam.api";
import {
  inviteEmailProblem,
  personLabel,
  rotateLine,
  teamErrorMessage,
  teamProjectOf,
  toggledKeys,
  type TeamMember,
} from "./projectTeam.logic";

export const projectTeamsQueryKey = ["projectTeams"] as const;

export function ProjectTeam(props: { syncName: string; teamId?: number | null }) {
  const queryClient = useQueryClient();
  const teams = useQuery({
    queryKey: projectTeamsQueryKey,
    queryFn: loadTeams,
    retry: false,
    staleTime: 15_000,
  });
  const row = teamProjectOf(teams.data, props.syncName, props.teamId);
  const teamId = row?.id ?? null;
  const cardKey = ["projectTeam", teamId] as const;
  const card = useQuery({
    queryKey: cardKey,
    enabled: teamId !== null,
    retry: false,
    queryFn: () => loadTeam(teamId!),
  });
  const [email, setEmail] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);
  const [noEmail, setNoEmail] = useState<string | null>(null);
  const [rotate, setRotate] = useState<string | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  // Teams aren't on here (or the interface has no sign-in): nothing to show.
  if (teams.isPending || teams.isError || teams.data === null) return null;

  const owner = card.data ? card.data.project.role === "owner" : (row?.role ?? "owner") === "owner";
  const allKeys = card.data?.secrets ?? [];

  const act = async (what: string, run: () => Promise<void>) => {
    setWorking(what);
    try {
      await run();
      void queryClient.invalidateQueries({ queryKey: projectTeamsQueryKey });
      void queryClient.invalidateQueries({ queryKey: cardKey });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't do that",
        description: teamErrorMessage(error),
      });
    } finally {
      setWorking(null);
    }
  };

  const sendInvite = () =>
    act("invite", async () => {
      const address = email.trim();
      const id = teamId ?? (await startTeam(props.syncName)).project.id;
      const answer = await invite(id, address);
      setInvited(address);
      setNoEmail(inviteEmailProblem(answer));
      setEmail("");
    });

  const remove = (member: TeamMember) =>
    act(`remove:${member.user_id}`, async () => {
      if (teamId === null) return;
      const result = await removeMember(teamId, member.user_id);
      setRemoving(null);
      const keys = result.keys_to_rotate ?? [];
      if (keys.length > 0) setRotate(rotateLine(personLabel(member), keys));
    });

  const setKey = (member: TeamMember, name: string, on: boolean) =>
    act(`keys:${member.user_id}`, async () => {
      if (teamId === null) return;
      await setMemberKeys(teamId, member.user_id, toggledKeys(member.secrets ?? [], name, on));
    });

  const copyLink = () => {
    void navigator.clipboard
      .writeText(UNO_WORK_URL)
      .then(() => toastManager.add({ type: "success", title: "Link copied" }));
  };

  return (
    <section className="space-y-2" data-testid="project-team">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <UsersIcon className="size-4 text-muted-foreground" />
        People
      </div>
      {rotate ? (
        <div
          className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/8 p-3 text-xs"
          data-testid="project-team-rotate"
        >
          <p className="text-foreground">{rotate}</p>
          <p className="text-muted-foreground">
            Get a new value where the key came from, then save it under Keys.
          </p>
          <Button size="xs" variant="outline" onClick={() => setRotate(null)}>
            Got it
          </Button>
        </div>
      ) : null}
      {(card.data?.members ?? []).length > 0 ? (
        <ul className="divide-y divide-border rounded-md border border-border text-xs">
          {card.data?.members.map((member) => (
            <li key={member.user_id} className="px-3 py-1.5" data-testid="project-team-member">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-foreground">
                  {personLabel(member)}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {member.role === "owner" ? "Owner" : "Editor"}
                </span>
                {owner && member.role !== "owner" ? (
                  removing === member.user_id ? (
                    <>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={working !== null}
                        onClick={() => void remove(member)}
                      >
                        Remove
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setRemoving(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={working !== null}
                      onClick={() => setRemoving(member.user_id)}
                    >
                      Remove
                    </Button>
                  )
                ) : null}
              </div>
              {owner && member.role !== "owner" && allKeys.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                  {allKeys.map((name) => (
                    <label key={name} className="flex cursor-pointer items-center gap-1.5">
                      <Checkbox
                        aria-label={`${name} for ${personLabel(member)}`}
                        checked={(member.secrets ?? []).includes(name)}
                        disabled={working !== null}
                        onCheckedChange={(checked) => void setKey(member, name, checked === true)}
                      />
                      <code className="font-mono text-foreground">{name}</code>
                    </label>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
          {(card.data?.invites ?? []).map((pending) => (
            <li key={pending.id} className="flex items-center gap-2 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-foreground">{pending.email}</span>
              <span className="shrink-0 text-muted-foreground">Invited</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={working !== null}
                onClick={() =>
                  void act(`cancel:${pending.id}`, async () => {
                    if (teamId !== null) await cancelInvite(teamId, pending.id);
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {noEmail ? (
        <p className="text-xs text-muted-foreground" data-testid="project-team-no-email">
          {noEmail}
        </p>
      ) : invited ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">
            Tell {invited} to sign in to Uno Work with this address. The invitation waits there for
            14 days.
          </span>
          <Button size="xs" variant="outline" onClick={copyLink}>
            <CopyIcon />
            Copy link
          </Button>
        </div>
      ) : null}
      {owner ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (email.trim()) void sendInvite();
          }}
        >
          <Input
            aria-label="Email to invite"
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!email.trim() || working !== null}
          >
            Invite
          </Button>
        </form>
      ) : null}
    </section>
  );
}
