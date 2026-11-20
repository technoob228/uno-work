/**
 * T51 mockup, the colleague's side of a shared chat: a chip in the header
 * ("Misha's chat · Can read"), a bar instead of the composer, and the
 * "Shared with you" rows at the top of the sidebar. Demo data only.
 */
import { useNavigate } from "@tanstack/react-router";
import { CopyPlusIcon, EyeIcon, HandIcon } from "lucide-react";
import { memo, useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useThreadTitle } from "../../hooks/useThreadTitle";
import { firstName, personById, useTeamCollab, type TeamPerson } from "../../team/teamCollab";
import { Button } from "../ui/button";
import { TeamAvatar } from "./TeamAvatar";

export function useSharedWithMe(threadId: string | null | undefined) {
  return useTeamCollab((state) =>
    state.enabled && threadId ? (state.sharedWithMe[threadId] ?? null) : null,
  );
}

export const SharedChatChip = memo(function SharedChatChip(props: { readonly threadId: string }) {
  const share = useSharedWithMe(props.threadId);
  const owner = useTeamCollab((state) => (share ? personById(state, share.ownerId) : null));
  if (!share) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/40 py-0.5 pr-2 pl-0.5 text-xs text-muted-foreground"
      data-testid="shared-chat-chip"
      title={`${firstName(owner)} shared this chat with you. It runs on ${firstName(owner)}'s ${share.computer}.`}
    >
      <TeamAvatar person={owner} className="size-4" />
      <span className="text-foreground">{firstName(owner)}'s chat</span>
      <span>·</span>
      <EyeIcon className="size-3" />
      {share.level === "read" ? "Can read" : "Can write"}
    </span>
  );
});

/** Instead of the composer in a chat you can only read. */
export const SharedChatReadOnlyBar = memo(function SharedChatReadOnlyBar(props: {
  readonly threadId: string;
}) {
  const share = useSharedWithMe(props.threadId);
  const owner = useTeamCollab((state) => (share ? personById(state, share.ownerId) : null));
  const [asked, setAsked] = useState(false);
  if (!share) return null;
  const name = firstName(owner);
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-[20px] border border-border bg-muted/30 px-4 py-3"
      data-testid="shared-chat-readonly"
    >
      <TeamAvatar person={owner} className="size-7" />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{name} shared this chat with you to read.</div>
        <div className="text-xs text-muted-foreground">
          It runs on {name}'s {share.computer} and updates here as it goes. You see the
          conversation, not {name}'s files.
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button size="sm" variant="outline" disabled={asked} onClick={() => setAsked(true)}>
          <HandIcon className="size-3.5" />
          {asked ? `Asked ${name}` : "Ask to write"}
        </Button>
        <Button size="sm" variant="outline">
          <CopyPlusIcon className="size-3.5" />
          Continue in my own chat
        </Button>
      </div>
    </div>
  );
});

/** The top of the sidebar in the colleague's Work. */
export const SidebarSharedWithMe = memo(function SidebarSharedWithMe() {
  const state = useTeamCollab();
  const navigate = useNavigate();
  const entries = Object.entries(state.sharedWithMe);
  if (!state.enabled || entries.length === 0) return null;
  return (
    <section className="shrink-0 pb-1.5" data-testid="sidebar-shared-with-me">
      <div className="flex h-6 items-center px-1 text-[11px] font-medium tracking-wide text-sidebar-muted-foreground uppercase">
        Shared with you
      </div>
      <ul role="list" className="flex flex-col gap-0.5">
        {entries.map(([threadId, share]) => (
          <SharedRow
            key={threadId}
            threadId={threadId}
            owner={personById(state, share.ownerId)}
            onOpen={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId: DEMO_HOST, threadId },
              })
            }
          />
        ))}
      </ul>
    </section>
  );
});

/** The demo's page computer: the shared chat's copy is shown through it. */
const DEMO_HOST = "env-demo-uno-work" as EnvironmentId;

function SharedRow(props: {
  readonly threadId: string;
  readonly owner: TeamPerson | null;
  readonly onOpen: () => void;
}) {
  const title = useThreadTitle(DEMO_HOST, props.threadId as ThreadId);
  return (
    <li className="list-none">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-accent"
        onClick={props.onOpen}
      >
        <TeamAvatar person={props.owner} className="size-5" />
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">
          {title ?? "Shared chat"}
        </span>
        <span className="shrink-0 text-[11px] text-sidebar-muted-foreground">
          {firstName(props.owner)}
        </span>
      </button>
    </li>
  );
}
