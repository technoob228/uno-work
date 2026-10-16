/**
 * An assistant's face: Uno's smile, or the emoji and tone picked in the
 * setup — with the status dot (working / waiting for you / free) the sidebar
 * and the assistant's page show.
 */
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

export function AssistantAvatar(props: {
  readonly emoji: string | null;
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
  return (
    <span
      className={cn("relative inline-flex shrink-0", size, props.revoked && "opacity-45 grayscale")}
      role={props.name ? "img" : undefined}
      aria-label={props.name ? `${props.name}${dot ? ` · ${ACTIVITY_LABEL[dot]}` : ""}` : undefined}
      aria-hidden={props.name ? undefined : true}
      data-testid="assistant-avatar"
    >
      {props.emoji === null ? (
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
