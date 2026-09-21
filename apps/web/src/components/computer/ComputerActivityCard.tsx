/**
 * "What it's doing": the last lines the computer's apps wrote, newest at the
 * bottom. Raw lines on purpose — it's a window into the machine, and the
 * "For engineers" door is where anything more technical lives.
 */
import type { UnoComputerActivity } from "@t3tools/contracts";
import { ScrollTextIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Skeleton } from "../ui/skeleton";
import { QuietState, SectionCard } from "./computerUi";

const VISIBLE_LINES = 14;

export function ComputerActivityCard({
  activity,
  loading,
}: {
  activity: UnoComputerActivity | undefined;
  loading: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const lines = activity?.lines.slice(-VISIBLE_LINES) ?? [];
  // Lines repeat (health checks), so each gets a key from its text plus how
  // many identical lines came before it — stable across polls that append.
  const seen = new Map<string, number>();
  const keyed = lines.map((line) => {
    const n = seen.get(line) ?? 0;
    seen.set(line, n + 1);
    return { line, key: `${line}#${n}` };
  });
  const tailKey = keyed.length > 0 ? keyed[keyed.length - 1]!.key : "";

  useEffect(() => {
    const el = scroller.current;
    if (el && tailKey) el.scrollTop = el.scrollHeight;
  }, [tailKey]);

  return (
    <SectionCard title="What it's doing" icon={<ScrollTextIcon />}>
      {loading && !activity ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : !activity || activity.availability !== "ok" ? (
        <QuietState
          availability={activity?.availability ?? "error"}
          message={activity?.message ?? null}
          soon="A running diary of what your computer and its apps are up to will show up here."
          offline="It's asleep, so it isn't doing anything right now."
        />
      ) : lines.length === 0 ? (
        <p className="text-xs text-muted-foreground">Quiet — nothing new to report.</p>
      ) : (
        <div
          ref={scroller}
          className="max-h-64 overflow-y-auto rounded-xl bg-muted/40 px-3.5 py-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
        >
          {keyed.map(({ line, key }, index) => (
            <div
              key={key}
              className={
                index === lines.length - 1
                  ? "text-foreground"
                  : /error|fail/i.test(line)
                    ? "text-destructive/80"
                    : ""
              }
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
