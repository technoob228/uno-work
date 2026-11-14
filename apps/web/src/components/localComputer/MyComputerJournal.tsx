/**
 * What agents did on one of the person's computers: newest first, each line
 * the time, what was done, the chat and how it ended, with its trust tier.
 * Plain text from the computer, never run. Shown in the manage card and in
 * Settings → My computer.
 */
import type { EnvironmentId, MyComputerActivityEntry, MyComputerTier } from "@t3tools/contracts";

import { useSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useMyComputerActivity } from "../../localComputer/useMyComputers";
import { formatShortTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { activityLine, activityTimeLabel } from "./connectComputer.logic";
import { journalMeta, TIER_LABEL, TIER_TONE, type TierTone } from "./myComputerTrust.logic";

const TONE_VARIANT: Record<TierTone, "outline" | "info" | "warning" | "error"> = {
  neutral: "outline",
  info: "info",
  warning: "warning",
  error: "error",
};

export function TierBadge({ tier }: { tier: MyComputerTier }) {
  return (
    <Badge variant={TONE_VARIANT[TIER_TONE[tier]]} size="sm" data-testid={`tier-${tier}`}>
      {TIER_LABEL[tier]}
    </Badge>
  );
}

function JournalLine({
  entry,
  nowMs,
  formatTime,
  showChat,
}: {
  entry: MyComputerActivityEntry;
  nowMs: number;
  formatTime: (iso: string) => string;
  showChat: boolean;
}) {
  const line = activityLine(entry);
  const meta = journalMeta(entry, showChat);
  const refused = entry.outcome === "refused";
  return (
    <li className="flex gap-3" data-testid="journal-line">
      <span className="w-16 shrink-0 pt-px text-muted-foreground tabular-nums">
        {activityTimeLabel(entry.at, nowMs, formatTime)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={cn("truncate", refused && "text-muted-foreground")} title={line}>
          {line}
        </span>
        {meta !== null ? (
          <span
            className={cn(
              "truncate text-xs text-muted-foreground",
              refused && "text-destructive-foreground",
            )}
            title={meta}
          >
            {meta}
          </span>
        ) : null}
      </span>
      {entry.tier !== undefined ? (
        <span className="shrink-0 pt-px">
          <TierBadge tier={entry.tier} />
        </span>
      ) : null}
    </li>
  );
}

export function MyComputerJournal({
  environmentId,
  computerId,
  limit,
  showChat = false,
  className,
  testId = "connect-actions",
}: {
  environmentId: EnvironmentId | null;
  computerId: string;
  limit?: number;
  /** The chat's title under each line (Settings: the person reads across chats). */
  showChat?: boolean;
  className?: string;
  testId?: string;
}) {
  const activity = useMyComputerActivity(
    environmentId,
    computerId,
    limit === undefined ? {} : { limit },
  );
  const timestampFormat = useSettings((settings) => settings.timestampFormat);
  const formatTime = (iso: string) => formatShortTimestamp(iso, timestampFormat);
  if (activity.data === undefined) {
    return activity.isError ? (
      <p className="text-sm text-muted-foreground">Couldn’t load what agents did.</p>
    ) : null;
  }
  if (activity.data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="connect-actions-empty">
        Agents haven’t used it yet.
      </p>
    );
  }
  const nowMs = activity.dataUpdatedAt;
  // Two lines can share a second and a summary: a counter keeps them apart.
  const seen = new Map<string, number>();
  const lineKey = (entry: MyComputerActivityEntry) => {
    const base = `${entry.at}-${entry.kind}-${entry.summary}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
  return (
    <ul
      className={cn("flex flex-col gap-2 overflow-y-auto text-sm", className)}
      aria-label="What agents did"
      data-testid={testId}
    >
      {activity.data.map((entry) => (
        <JournalLine
          key={lineKey(entry)}
          entry={entry}
          nowMs={nowMs}
          formatTime={formatTime}
          showChat={showChat}
        />
      ))}
    </ul>
  );
}
