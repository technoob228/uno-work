/**
 * The top of the My Uno overview: the plan line (plan, how much of it is
 * running now, balance, Uno AI credits → Plan & billing) and "Worth a look" —
 * only what needs a decision, each with the one thing to do about it, or a
 * quiet "Everything is running." when nothing does.
 */
import { ChevronRightIcon, SparklesIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import type { AccountBalance, AccountSubscription } from "../../account/accountOverview";
import { formatRam, formatUsd, planTitle } from "../../account/billingModel";
import { Meter } from "../computer/computerUi";
import { Button } from "../ui/button";
import { planRunning, type WorthItem } from "./myUnoModel";
import { Dot } from "./rowsUi";

export function PlanLine({
  subscription,
  subscriptionLoading,
  balance,
  onOpen,
}: {
  subscription: AccountSubscription | null;
  subscriptionLoading: boolean;
  balance: AccountBalance | undefined;
  onOpen: () => void;
}) {
  const running = planRunning(subscription);
  const name = subscriptionLoading
    ? "…"
    : subscription
      ? planTitle(subscription.limits, subscription.plan)
      : "No plan";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card/40 px-4 py-3 text-left transition-colors hover:bg-accent/40"
      data-testid="my-uno-plan-strip"
    >
      <span className="flex items-center gap-2 text-sm">
        <SparklesIcon className="size-4 text-primary" />
        <span className="font-medium">{name}</span>
        {subscription && subscription.priceUsd > 0 ? (
          <span className="text-xs text-muted-foreground">
            {formatUsd(subscription.priceUsd)}/mo
          </span>
        ) : null}
      </span>
      {running ? (
        <span
          className="flex items-center gap-2 text-xs"
          title="Computers running at once, out of what the plan allows. Sleeping computers don't count."
        >
          <Meter value={running.pct} className="w-20" />
          <span className="tabular-nums">
            {formatRam(running.usedRamMb)} running{" "}
            <span className="text-muted-foreground">· {formatRam(running.freeRamMb)} free</span>
          </span>
        </span>
      ) : null}
      <span className="text-xs text-muted-foreground">
        Balance{" "}
        <span className="font-medium text-foreground tabular-nums">
          {balance ? formatUsd(balance.balanceUsd) : "…"}
        </span>
      </span>
      <span className="text-xs text-muted-foreground">
        Uno AI credits{" "}
        <span className="font-medium text-foreground tabular-nums">
          {balance ? formatUsd(balance.aiBalanceUsd) : "…"}
        </span>
      </span>
      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        Plan & billing
        <ChevronRightIcon className="size-3.5" />
      </span>
    </button>
  );
}

export function WorthALook({
  items,
  onLook,
}: {
  items: ReadonlyArray<WorthItem>;
  onLook: (item: WorthItem) => void;
}) {
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const shown = items.filter((item) => !hidden.has(item.key));

  if (shown.length === 0) {
    return (
      <p
        className="flex items-center gap-2 px-1 text-sm text-muted-foreground"
        data-testid="my-uno-all-good"
      >
        <Dot tone="ok" />
        Everything is running.
      </p>
    );
  }
  return (
    <section className="flex flex-col gap-2" data-testid="my-uno-worth-a-look">
      <h2 className="text-sm font-semibold">Worth a look</h2>
      <ul className="overflow-hidden rounded-2xl border border-border/70">
        {shown.map((item) => (
          <li
            key={item.key}
            className="group flex items-center gap-3 border-b border-border/50 px-3.5 py-2 text-sm last:border-0"
          >
            <TriangleAlertIcon className="size-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 truncate">
              {item.kind === "computer" ? (
                <>
                  <span className="font-medium">{item.entry.name}</span> isn't responding
                </>
              ) : (
                <>
                  <span className="font-medium">{item.app.name}</span> didn't install on{" "}
                  {item.entry.name}
                </>
              )}
            </span>
            <Button size="xs" variant="outline" onClick={() => onLook(item)}>
              {item.kind === "computer" ? "What to do" : "Details"}
            </Button>
            <button
              type="button"
              aria-label="Hide"
              onClick={() => setHidden(new Set([...hidden, item.key]))}
              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100"
            >
              <XIcon className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
