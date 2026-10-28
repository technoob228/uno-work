/**
 * The left of a teammate chat's header (Misha 16.10): its face, name and
 * status — not Uno's — with one click to its page, where everything it was
 * told in its setup chat can be seen and changed.
 */
import { useNavigate } from "@tanstack/react-router";

import { AssistantAvatar, avatarImageOf } from "./AssistantAvatar";
import { ACTIVITY_LABEL, profileLine } from "./assistantTeam.logic";
import type { TeamMember } from "./useAssistantTeam";

export function TeammateChatHeadline(props: {
  readonly member: TeamMember;
  readonly title: string;
}) {
  const { member } = props;
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() =>
        void navigate({
          to: "/assistants",
          search: { view: "profile", env: member.environmentId, project: member.projectId },
        })
      }
      title={`${member.profile.name}'s page`}
      className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-md text-left hover:opacity-80"
      data-testid="teammate-headline"
    >
      <AssistantAvatar
        emoji={member.profile.emoji}
        image={avatarImageOf(member.profile)}
        tone={member.profile.tone}
        activity={member.activity}
        className="size-7 shrink-0"
        emojiClassName="text-sm"
      />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-medium text-foreground">
          {member.profile.name}
          <span className="font-normal text-muted-foreground"> · {props.title}</span>
        </span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {member.profile.setUpAt === null
            ? "Setting itself up with you"
            : `${ACTIVITY_LABEL[member.activity]} · ${profileLine(member.profile)}`}
        </span>
      </span>
    </button>
  );
}
