/**
 * "Waiting for you · 3" above the composer (T52, Misha 20.11): the cards
 * and site links in this chat the person hasn't dealt with, however far
 * the talk went since. A row jumps to its place in the feed (and lights it);
 * a link row opens the link in the panel; "Not needed" hides a row. The
 * strip folds to one line; with nothing waiting it is gone.
 * What waits is kept by the computer (@t3tools/shared/pendingForYou).
 */
import type { EnvironmentId, ThreadPendingItem, ThreadPendingLink } from "@t3tools/contracts";
import { pendingForYouSummary } from "@t3tools/shared/pendingForYou";
import { ChevronDownIcon, CircleCheckIcon, GlobeIcon, LayoutListIcon, XIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "../../lib/utils";
import { selectEnvironmentState, useStore } from "../../store";
import { formatRelativeTimeLabel } from "../../timestampFormat";

function KindIcon({ kind }: { kind: ThreadPendingItem["kind"] }) {
  const className = "size-3.5 shrink-0 text-warning";
  if (kind === "links") return <GlobeIcon aria-hidden className={className} />;
  return <LayoutListIcon aria-hidden className={className} />;
}

function itemMeta(item: ThreadPendingItem): string {
  if (item.kind === "links") {
    const opened = item.links.filter((link) => link.opened).length;
    const count = item.links.length;
    return `${count} ${count === 1 ? "link" : "links"}${opened > 0 ? ` · ${opened} opened` : ""}`;
  }
  return "Card";
}

export const PendingForYouStrip = memo(function PendingForYouStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<ThreadPendingItem>;
  readonly hidden: ReadonlyArray<ThreadPendingItem>;
  readonly folded: boolean;
  readonly onFoldedChange: (folded: boolean) => void;
  readonly onShow: (item: ThreadPendingItem) => void;
  readonly onOpenLink: (item: ThreadPendingItem, link: ThreadPendingLink) => void;
  readonly onDismiss: (item: ThreadPendingItem) => void;
  readonly onRestoreHidden: () => void;
}) {
  const { environmentId, items, hidden, folded } = props;
  const shells = useStore((state) => selectEnvironmentState(state, environmentId).threadShellById);
  const fromTitle = useMemo(() => {
    const titles = new Map<string, string>();
    for (const item of items) {
      if (item.broughtByThreadId) {
        const title = shells[item.broughtByThreadId]?.title;
        if (title) titles.set(item.id, title);
      }
    }
    return titles;
  }, [items, shells]);

  if (items.length === 0) return null;

  return (
    <div
      data-testid="pending-for-you"
      data-folded={folded ? "true" : undefined}
      className="mx-auto mb-2 max-w-208 rounded-lg border border-warning/40 bg-warning/6 text-xs"
    >
      <button
        type="button"
        aria-expanded={!folded}
        onClick={() => props.onFoldedChange(!folded)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        data-testid="pending-for-you-toggle"
      >
        <span className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full rounded-full bg-warning opacity-60 motion-safe:animate-ping [animation-iteration-count:2]" />
          <span className="relative inline-flex size-2 rounded-full bg-warning" />
        </span>
        <span className="shrink-0 font-medium text-foreground">
          Waiting for you · <span data-testid="pending-for-you-count">{items.length}</span>
        </span>
        {folded ? (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {pendingForYouSummary(items)}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">in this chat</span>
        )}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !folded && "rotate-180",
          )}
        />
      </button>
      {folded ? null : (
        <div className="max-h-[min(14rem,40vh)] overflow-y-auto border-t border-warning/25 py-1">
          <ul role="list">
            {items.map((item) => {
              const from = fromTitle.get(item.id);
              const nextLink = item.links.find((link) => !link.opened) ?? item.links[0];
              return (
                <li
                  key={item.id}
                  className="group/pending flex min-w-0 items-center gap-2 px-2.5 py-1"
                  data-testid="pending-for-you-row"
                  data-kind={item.kind}
                >
                  <KindIcon kind={item.kind} />
                  <button
                    type="button"
                    title="Show it in the chat"
                    onClick={() => props.onShow(item)}
                    className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 rounded-sm text-left outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                    data-testid="pending-for-you-show"
                  >
                    <span className="min-w-0 truncate font-medium text-foreground underline-offset-2 group-hover/pending:underline">
                      {item.title}
                    </span>
                    <span className="hidden shrink-0 text-muted-foreground sm:inline">
                      {itemMeta(item)}
                    </span>
                    {item.answersYou ? (
                      <span className="hidden shrink-0 items-center gap-1 text-emerald-700 sm:flex dark:text-emerald-300/90">
                        <CircleCheckIcon aria-hidden className="size-3" />
                        Your answer
                      </span>
                    ) : from ? (
                      <span className="hidden min-w-0 shrink truncate text-muted-foreground md:inline">
                        from {from}
                      </span>
                    ) : null}
                  </button>
                  <span className="shrink-0 text-muted-foreground/80 tabular-nums">
                    {formatRelativeTimeLabel(item.createdAt)}
                  </span>
                  {item.kind === "links" && nextLink ? (
                    <button
                      type="button"
                      onClick={() => props.onOpenLink(item, nextLink)}
                      className="shrink-0 cursor-pointer rounded-md border border-border bg-background px-1.5 py-0.5 font-medium text-foreground outline-hidden hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                      title={nextLink.href}
                      data-testid="pending-for-you-open"
                    >
                      Open {nextLink.label.length <= 14 ? nextLink.label : ""}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => props.onShow(item)}
                      className="shrink-0 cursor-pointer rounded-md border border-border bg-background px-1.5 py-0.5 font-medium text-foreground outline-hidden hover:bg-accent focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      Show
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => props.onDismiss(item)}
                    aria-label={`Not needed: ${item.title}`}
                    title="Not needed — hide it from this list"
                    className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-muted-foreground opacity-60 outline-hidden group-hover/pending:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring [@media(hover:none)]:opacity-100"
                    data-testid="pending-for-you-dismiss"
                  >
                    <XIcon aria-hidden className="size-3" />
                    <span className="hidden lg:inline">Not needed</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {hidden.length > 0 ? (
            <div className="flex items-center gap-1.5 px-2.5 pt-0.5 pb-0.5 text-muted-foreground">
              <span>{hidden.length} hidden</span>
              <span aria-hidden>·</span>
              <button
                type="button"
                onClick={props.onRestoreHidden}
                className="cursor-pointer rounded-sm underline-offset-2 outline-hidden hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="pending-for-you-restore"
              >
                Show again
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});

/** Above a row "Waiting for you" lists, or a card a newer one with its title replaced (T52). */
export const PendingMarkLine = memo(function PendingMarkLine(props: {
  mark: "waiting" | "replaced";
}) {
  return props.mark === "waiting" ? (
    <div
      className="mx-1 flex items-center gap-1.5 pb-1 text-[12px] font-medium text-warning"
      data-testid="pending-mark-waiting"
    >
      <span aria-hidden className="size-1.5 rounded-full bg-warning" />
      <span>Waiting for you</span>
    </div>
  ) : (
    <div
      className="mx-1 flex items-center gap-1.5 pb-1 text-[12px] text-muted-foreground"
      data-testid="pending-mark-replaced"
    >
      <span>Replaced by a newer card below</span>
    </div>
  );
});

/**
 * A feed row's look for "Waiting for you": the row the strip jumped to is lit
 * for a moment — a ring over the row (the list clips anything outside it),
 * above a card's frame; a replaced card is dimmed.
 */
export function pendingRowClassName(
  highlighted: boolean,
  mark: "waiting" | "replaced" | null,
): string {
  return cn(
    "relative rounded-xl transition-colors duration-700 after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-xl after:ring-2 after:ring-transparent after:ring-inset after:transition-shadow after:duration-700",
    highlighted && "bg-warning/8 after:ring-warning/70",
    mark === "replaced" && "opacity-60",
  );
}
