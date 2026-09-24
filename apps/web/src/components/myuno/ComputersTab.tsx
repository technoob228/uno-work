/**
 * "Computers" on My Uno — one row per computer, in two groups: Uno Work
 * ("where you work": Open on hover, "You're here", Wake up when asleep) and
 * servers ("run things for you": no big button — Wake up when asleep, that's
 * all). Every row says what runs on it (App Store apps as chips, red when one
 * didn't install) and what it costs out of the plan. A click opens the side
 * panel with everything else. Filters: All · Uno Work · Servers · Asleep, and
 * a search by name, app or address.
 */
import { Loader2Icon, PlusIcon, SquareArrowOutUpRightIcon, SunIcon } from "lucide-react";
import { useState } from "react";

import type { AccountSubscription } from "../../account/accountOverview";
import { formatRam, formatUsd } from "../../account/billingModel";
import { ROLE_LABEL } from "../../account/computerRoles";
import { cn } from "../../lib/utils";
import { isWebLite, liteEmptyComputersCopy } from "../../lite/webLite";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  type ComputerEntry,
  type ComputerFilter,
  entryShare,
  filterCounts,
  groupEntries,
  groupShare,
  hasProblem,
  isAsleep,
  rowAction,
  stateLabel,
  stateTone,
} from "./myUnoModel";
import { ROLE_ICON, ROLE_TEXT } from "./roleUi";
import { AppChip, Chip, Dot, GroupTitle, HOVER_ONLY, Row, RowList, SearchBox } from "./rowsUi";
import type { ComputerActions } from "./useComputerActions";

export interface ComputersTabProps {
  readonly entries: ReadonlyArray<ComputerEntry>;
  readonly loading: boolean;
  readonly error: unknown;
  readonly subscription: AccountSubscription | null;
  readonly selectedKey: string | null;
  readonly onSelect: (entry: ComputerEntry) => void;
  readonly onOpen: (entry: ComputerEntry) => void;
  /** "Connecting…" while a computer is being opened. */
  readonly opening: { readonly key: string; readonly label: string } | null;
  readonly actions: ComputerActions;
  readonly onAdd: () => void;
}

function sizeAndCost(entry: ComputerEntry, subscription: AccountSubscription | null): string {
  if (!entry.box) return "free";
  const share = entryShare(entry, subscription);
  const ram = entry.box.ramMb > 0 ? formatRam(entry.box.ramMb) : "";
  const cost = share === null ? "" : `≈ ${formatUsd(share)}`;
  return [ram, cost].filter(Boolean).join(" · ");
}

export function ComputersTab(props: ComputersTabProps) {
  const { entries, loading, error, subscription, onAdd } = props;
  const [filter, setFilter] = useState<ComputerFilter>("all");
  const [query, setQuery] = useState("");
  const counts = filterCounts(entries);
  const groups = groupEntries(entries, filter, query);
  const workShare = groupShare(groups.work, subscription);
  const serverShare = groupShare(groups.servers, subscription);

  return (
    <div className="flex flex-col gap-2" data-testid="my-uno-computers">
      <div className="flex flex-wrap items-center gap-1">
        <Chip active={filter === "all"} onClick={() => setFilter("all")} count={counts.all}>
          All
        </Chip>
        <Chip active={filter === "work"} onClick={() => setFilter("work")} count={counts.work}>
          Uno Work
        </Chip>
        <Chip
          active={filter === "servers"}
          onClick={() => setFilter("servers")}
          count={counts.servers}
        >
          Servers
        </Chip>
        <Chip
          active={filter === "asleep"}
          onClick={() => setFilter("asleep")}
          count={counts.asleep}
        >
          Asleep
        </Chip>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <SearchBox
            value={query}
            onChange={setQuery}
            placeholder="Name, app or address"
            className="w-44 sm:w-52"
          />
          <Button size="sm" variant="outline" onClick={onAdd}>
            <PlusIcon />
            Add
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2 pt-2">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </div>
      ) : error && entries.length === 0 ? (
        <p className="rounded-2xl border border-border/60 px-4 py-3 text-xs text-muted-foreground">
          Couldn't read your computers just now. It will try again in a moment.
        </p>
      ) : entries.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/80 px-4 py-6 text-center text-sm text-muted-foreground">
          {(isWebLite ? liteEmptyComputersCopy(subscription) : null) ??
            "No computers in the cloud yet. Add one — an Uno Work computer to work on, or a small server for a VPN or a bot."}
        </p>
      ) : (
        <>
          {groups.work.length > 0 ? (
            <>
              <GroupTitle right={workShare === null ? null : `≈ ${formatUsd(workShare)}/mo`}>
                Uno Work — where you work
              </GroupTitle>
              <RowList testId="my-uno-work-group">
                {groups.work.map((entry) => (
                  <ComputerRow key={entry.key} entry={entry} {...props} />
                ))}
              </RowList>
            </>
          ) : null}
          {groups.servers.length > 0 ? (
            <>
              <GroupTitle right={serverShare === null ? null : `≈ ${formatUsd(serverShare)}/mo`}>
                Servers — run things for you
              </GroupTitle>
              <RowList testId="my-uno-server-group">
                {groups.servers.map((entry) => (
                  <ComputerRow key={entry.key} entry={entry} {...props} />
                ))}
              </RowList>
            </>
          ) : null}
          {groups.work.length === 0 && groups.servers.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing matches.{" "}
              <button
                type="button"
                className="text-primary hover:underline"
                onClick={() => {
                  setFilter("all");
                  setQuery("");
                }}
              >
                Show all
              </button>
            </p>
          ) : null}
          <p className="px-1 pt-1 text-xs text-muted-foreground">
            Click a computer to see its load, apps and logs, put it to sleep or change what it's
            for.
          </p>
        </>
      )}
    </div>
  );
}

function ComputerRow({
  entry,
  subscription,
  selectedKey,
  onSelect,
  onOpen,
  opening,
  actions,
}: ComputerTabRowProps) {
  const asleep = isAsleep(entry);
  const tone = stateTone(entry);
  const action = rowAction(entry);
  const pending = entry.box ? actions.pending(entry.box.id) : null;
  const openingLabel = opening?.key === entry.key ? opening.label : null;
  const paused = entry.state !== "on";

  const button =
    pending === "wake" || pending === "start" ? (
      <Button size="xs" variant="outline" disabled>
        <Loader2Icon className="animate-spin" />
        Waking…
      </Button>
    ) : openingLabel ? (
      <Button size="xs" variant="outline" disabled>
        <Loader2Icon className="animate-spin" />
        {openingLabel}
      </Button>
    ) : action === "wake" && entry.box ? (
      <Button size="xs" variant="outline" onClick={() => entry.box && actions.bringBack(entry.box)}>
        <SunIcon />
        Wake up
      </Button>
    ) : action === "here" ? (
      <Button size="xs" variant="ghost" onClick={() => onOpen(entry)}>
        <SquareArrowOutUpRightIcon />
        You're here
      </Button>
    ) : action === "open" ? (
      <Button size="xs" variant="outline" className={HOVER_ONLY} onClick={() => onOpen(entry)}>
        <SquareArrowOutUpRightIcon />
        Open
      </Button>
    ) : null;

  // Uno Work rows: what runs there. Server rows: its role, apps, then where it answers.
  const middle = entry.work ? (
    <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
      {entry.local ? (
        <span className="truncate text-xs text-muted-foreground">
          Your own computer · not on the plan
        </span>
      ) : null}
      {entry.apps.map((app) => (
        <AppChip key={app.id} app={app} paused={paused} />
      ))}
      {entry.state !== "on" ? <span className="shrink-0 text-xs">{stateLabel(entry)}</span> : null}
    </span>
  ) : (
    <>
      <span
        className={cn(
          "hidden w-24 shrink-0 items-center gap-1 text-[11px] font-medium sm:inline-flex [&_svg]:size-3",
          ROLE_TEXT[entry.role],
        )}
      >
        {ROLE_ICON[entry.role]}
        {ROLE_LABEL[entry.role]}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {entry.apps.map((app) => (
          <AppChip key={app.id} app={app} paused={paused} />
        ))}
        {entry.state !== "on" ? (
          <span className={cn("shrink-0 text-xs", entry.broken && "text-destructive-foreground")}>
            {stateLabel(entry)}
          </span>
        ) : entry.apps.length === 0 ? (
          <span className="truncate text-xs text-muted-foreground">
            {entry.box?.note || "Nothing from the App Store yet"}
          </span>
        ) : entry.addresses[0] ? (
          <span className="truncate text-xs text-muted-foreground">{entry.addresses[0]}</span>
        ) : null}
      </span>
    </>
  );

  return (
    <Row
      selected={selectedKey === entry.key}
      dim={asleep}
      bad={hasProblem(entry)}
      onSelect={() => onSelect(entry)}
      label={`${entry.name}, ${stateLabel(entry)}`}
      action={<span className="flex w-24 justify-end sm:w-28">{button}</span>}
      testId="my-uno-computer"
    >
      <Dot tone={tone} />
      <span className="w-32 shrink-0 truncate font-medium sm:w-40" title={entry.name}>
        {entry.name}
      </span>
      {middle}
      <span className="hidden w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
        {sizeAndCost(entry, subscription)}
      </span>
    </Row>
  );
}

type ComputerTabRowProps = ComputersTabProps & { readonly entry: ComputerEntry };
