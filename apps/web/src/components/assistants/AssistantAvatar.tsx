/**
 * An assistant's face: Uno's smile, its picture (Misha 23.10), or the emoji
 * and tone picked in the setup — with the status dot (working / waiting for
 * you / free) the sidebar and the assistant's page show.
 *
 * The picture comes from the assistant's computer (owner session only), read
 * once per file name: a new picture has a new name.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { fetchAssistantAvatar } from "../../lib/managerApi";
import { cn } from "../../lib/utils";
import { UnoFace } from "../sidebar/SidebarDParts";
import { ACTIVITY_LABEL, type AssistantActivity, type AvatarTone } from "./assistantTeam.logic";

const TONE_BG: Readonly<Record<AvatarTone, string>> = {
  amber: "bg-amber-500/18",
  teal: "bg-teal-500/18",
  orange: "bg-orange-500/18",
  violet: "bg-violet-500/18",
  sky: "bg-sky-500/18",
  emerald: "bg-emerald-500/18",
  rose: "bg-rose-500/18",
  slate: "bg-slate-500/18",
};

const DOT: Readonly<Record<AssistantActivity, string>> = {
  working: "bg-sky-500",
  waiting: "bg-amber-500",
  idle: "bg-success",
};

/** Where its picture is: its computer, its folder, the file's name. */
export interface AvatarImageRef {
  readonly environmentId: string;
  readonly projectId: string;
  readonly avatar: string;
}

/** The picture of an assistant whose profile names one; null for its emoji. */
export function avatarImageOf(profile: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly avatar?: string | null | undefined;
}): AvatarImageRef | null {
  return profile.avatar
    ? { environmentId: profile.environmentId, projectId: profile.projectId, avatar: profile.avatar }
    : null;
}

export const AVATAR_IMAGE_KEY = ["uno-assistant", "avatar"] as const;

/** Its picture as a `data:` URL; null while it loads or when it can't be read (the emoji shows). */
export function useAssistantAvatarUrl(image: AvatarImageRef | null | undefined): string | null {
  const query = useQuery({
    queryKey: [...AVATAR_IMAGE_KEY, image?.environmentId, image?.projectId, image?.avatar],
    queryFn: () =>
      fetchAssistantAvatar({
        environmentId: image!.environmentId as EnvironmentId,
        projectId: image!.projectId,
      }),
    enabled: Boolean(image),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 30 * 60_000,
    retry: false,
  });
  return image ? (query.data ?? null) : null;
}

export function AssistantAvatar(props: {
  readonly emoji: string | null;
  /** Its picture, shown instead of the emoji once it is here. */
  readonly image?: AvatarImageRef | null | undefined;
  /** A picture already in hand (a preview in the face picker). */
  readonly src?: string | null | undefined;
  readonly tone: AvatarTone;
  readonly activity?: AssistantActivity | null | undefined;
  readonly revoked?: boolean | undefined;
  readonly className?: string | undefined;
  readonly name?: string | undefined;
  /** The emoji's size for avatars bigger than the sidebar's. */
  readonly emojiClassName?: string | undefined;
}) {
  const size = props.className ?? "size-5";
  const dot = props.activity && !props.revoked ? props.activity : null;
  const fetched = useAssistantAvatarUrl(props.src ? null : props.image);
  const picture = props.src ?? fetched;
  return (
    <span
      className={cn("relative inline-flex shrink-0", size, props.revoked && "opacity-45 grayscale")}
      role={props.name ? "img" : undefined}
      aria-label={props.name ? `${props.name}${dot ? ` · ${ACTIVITY_LABEL[dot]}` : ""}` : undefined}
      aria-hidden={props.name ? undefined : true}
      data-testid="assistant-avatar"
    >
      {picture ? (
        <img
          src={picture}
          alt=""
          draggable={false}
          className="size-full rounded-full object-cover"
          data-testid="assistant-avatar-image"
        />
      ) : props.emoji === null ? (
        <UnoFace className="size-full" />
      ) : (
        <span
          className={cn(
            "grid size-full place-items-center rounded-full leading-none",
            TONE_BG[props.tone],
          )}
        >
          <span className={cn("leading-none", props.emojiClassName ?? "text-[11px]")}>
            {props.emoji}
          </span>
        </span>
      )}
      {dot ? (
        <span
          aria-hidden
          className={cn(
            "absolute -right-px -bottom-px size-[42%] rounded-full border-[1.5px] border-sidebar",
            DOT[dot],
            dot === "working" && "animate-pulse",
          )}
        />
      ) : null}
    </span>
  );
}
