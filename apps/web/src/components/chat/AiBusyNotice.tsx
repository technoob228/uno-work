/**
 * Uno AI hours: one calm line above the composer, only while tasks run slower
 * than full speed (the plan's AI power is shared by every chat and agent).
 * Full speed says nothing. The daemon asks `/v1/ai/status` every 15 s while
 * a chat on Uno AI works; a gateway without AI hours never shows it.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { memo } from "react";

import { consoleLinks } from "../../account/accountOverview";
import { aiBusyNotice, useAiStatus } from "../../lib/aiStatusReactQuery";
import { openInNewTab } from "../../navigation/useOpenApp";

const RENEW_DATE = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export function aiBusyNoticeText(notice: NonNullable<ReturnType<typeof aiBusyNotice>>): {
  readonly text: string;
  readonly link: string | null;
} {
  if (notice.kind === "standard-speed") {
    const at = notice.renewsAt ? Date.parse(notice.renewsAt) : Number.NaN;
    const until = Number.isFinite(at)
      ? ` until ${RENEW_DATE.format(at)}`
      : " until your plan renews";
    return {
      text: `You've used this month's full-speed hours — AI keeps working at standard speed${until}.`,
      link: null,
    };
  }
  return { text: "AI is busy, tasks run a bit slower.", link: "More AI power on bigger plans →" };
}

export const AiBusyNotice = memo(function AiBusyNotice(props: {
  environmentId: EnvironmentId | null;
  /** A chat on Uno AI is working right now: only then is the status asked. */
  active: boolean;
}) {
  const status = useAiStatus(props.environmentId, { poll: props.active, enabled: props.active });
  const notice = props.active ? aiBusyNotice(status) : null;
  if (!notice) return null;
  const { text, link } = aiBusyNoticeText(notice);
  return (
    <p
      className="mx-auto mb-1.5 flex max-w-3xl flex-wrap items-center gap-x-1.5 px-3 text-xs text-muted-foreground"
      role="status"
      data-testid="ai-busy-notice"
    >
      <span>{text}</span>
      {link ? (
        <button
          type="button"
          className="underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => openInNewTab(consoleLinks.plans)}
        >
          {link}
        </button>
      ) : null}
    </p>
  );
});
