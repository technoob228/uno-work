/**
 * Journal of every way into a computer: the "Your computers" overview and the
 * "Who got in" list for the picked one. Data comes from the console (Uno's own
 * records + the computer's SSH login journal, read on each load). Wording and
 * grouping live in accessJournal.logic.ts.
 */
import { useQuery } from "@tanstack/react-query";
import type { UnoBox } from "@t3tools/contracts";
import {
  AppWindowIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  CogIcon,
  LifeBuoyIcon,
  MonitorIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TerminalIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { accountRequest } from "../../../account/unoAccount";
import { cn } from "../../../lib/utils";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { SettingsRow, SettingsSection, useRelativeTimeTick } from "../settingsLayout";
import {
  ACCESS_FILTERS,
  type AccessBurst,
  type AccessEntry,
  type AccessFilter,
  type AccessLogResponse,
  accessLogPath,
  automaticLabel,
  burstLabel,
  channelLabel,
  collapseBursts,
  entryText,
  failedAttemptsLine,
  formatClock,
  groupByDay,
  isMaintenance,
  isUnexplained,
  lastAccessLine,
  matchesFilter,
  overviewBadge,
  scanNote,
  type SecuritySummaryResponse,
  securitySummaryPath,
  verdictFor,
  type Verdict,
} from "./accessJournal.logic";

const BADGE_VARIANT = { good: "success", notice: "warning", bad: "error" } as const;

function VerdictIcon({
  tone,
  className,
}: {
  readonly tone: Verdict["tone"];
  readonly className?: string;
}) {
  if (tone === "good") return <ShieldCheckIcon className={cn(className, "text-success")} />;
  if (tone === "notice") return <WrenchIcon className={cn(className, "text-warning")} />;
  return <ShieldAlertIcon className={cn(className, "text-destructive")} />;
}

const summaryKey = ["account", "security", "summary"] as const;
const accessLogKey = (boxId: number) => ["account", "security", "accessLog", boxId] as const;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function SecurityOverview({
  boxes,
  selectedId,
  onSelect,
}: {
  readonly boxes: ReadonlyArray<UnoBox>;
  readonly selectedId: number | null;
  readonly onSelect: (id: number) => void;
}) {
  const now = useRelativeTimeTick(30_000);
  const summary = useQuery({
    queryKey: summaryKey,
    queryFn: async () =>
      (await accountRequest("GET", securitySummaryPath)) as SecuritySummaryResponse,
  });
  const byId = new Map((summary.data?.computers ?? []).map((c) => [c.box_id, c]));

  return (
    <SettingsSection title="Your computers">
      {summary.isError ? (
        <SettingsRow title="Couldn't load the overview" description={errorText(summary.error)} />
      ) : null}
      {boxes.map((box) => {
        const computer = byId.get(box.id);
        const badge = computer ? overviewBadge(computer) : null;
        const selected = box.id === selectedId;
        return (
          <button
            key={box.id}
            type="button"
            onClick={() => onSelect(box.id)}
            aria-pressed={selected}
            className={cn(
              "flex w-full items-center gap-3 border-t border-border/60 px-4 py-3 text-left first:border-t-0 sm:px-5",
              "cursor-pointer transition-colors hover:bg-accent/40",
              selected && boxes.length > 1 && "bg-accent/60",
            )}
          >
            <MonitorIcon className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">{computer?.name || box.name}</div>
              <div className="truncate text-xs text-muted-foreground">
                {computer ? lastAccessLine(computer, now) : summary.isPending ? "Loading…" : ""}
              </div>
            </div>
            {badge ? (
              <Badge variant={BADGE_VARIANT[badge.tone]} size="sm">
                {badge.tone === "good" ? (
                  <ShieldCheckIcon className="size-3" />
                ) : badge.tone === "notice" ? (
                  <WrenchIcon className="size-3" />
                ) : (
                  <ShieldAlertIcon className="size-3" />
                )}
                {badge.text}
              </Badge>
            ) : null}
          </button>
        );
      })}
    </SettingsSection>
  );
}

function ChannelIcon({ entry }: { readonly entry: AccessEntry }) {
  const cls = "size-4 shrink-0";
  if (isUnexplained(entry)) return <ShieldAlertIcon className={cn(cls, "text-destructive")} />;
  if (isMaintenance(entry)) return <WrenchIcon className={cn(cls, "text-warning")} />;
  switch (entry.channel) {
    case "work":
      return <MonitorIcon className={cls} />;
    case "ssh":
      return <TerminalIcon className={cls} />;
    case "command":
      return entry.actor === "agent" ? (
        <BotIcon className={cls} />
      ) : (
        <TerminalIcon className={cls} />
      );
    case "cron":
      return <ClockIcon className={cls} />;
    case "app":
      return <AppWindowIcon className={cls} />;
    case "support":
      return <LifeBuoyIcon className={cls} />;
    case "system":
      return <CogIcon className={cls} />;
    default:
      return <UserIcon className={cls} />;
  }
}

function EntryRow({ entry }: { readonly entry: AccessEntry }) {
  const bad = isUnexplained(entry);
  const amber = isMaintenance(entry);
  const how = channelLabel(entry);
  const text = entryText(entry);
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-4 py-2 text-xs sm:px-5",
        bad && "bg-destructive/6 text-destructive-foreground",
        amber && "bg-warning/6",
      )}
    >
      <span className="w-10 shrink-0 pt-0.5 tabular-nums text-muted-foreground">
        {formatClock(entry.at)}
      </span>
      <span className="pt-0.5 text-muted-foreground">
        <ChannelIcon entry={entry} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="text-[13px]">
          <span
            className={cn(
              "font-medium",
              bad && "text-destructive",
              amber && "text-warning-foreground",
            )}
          >
            {text.title}
          </span>
          <span className="text-muted-foreground"> · {how}</span>
          {entry.from_ip ? (
            <span className="text-muted-foreground"> · from {entry.from_ip}</span>
          ) : null}
        </div>
        {text.note ? <div className="text-muted-foreground">{text.note}</div> : null}
      </div>
    </li>
  );
}

/** One maintenance run (or one unexplained burst) as a single expandable line. */
function BurstRow({ burst }: { readonly burst: AccessBurst }) {
  const [open, setOpen] = useState(false);
  const first = burst.entries[0]!;
  const bad = isUnexplained(first);
  const text = entryText(first);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          "flex w-full cursor-pointer items-start gap-3 px-4 py-2 text-left text-xs sm:px-5",
          bad ? "bg-destructive/6" : "bg-warning/6",
        )}
      >
        <span className="w-10 shrink-0 pt-0.5 tabular-nums text-muted-foreground">
          {formatClock(burst.entries[burst.entries.length - 1]!.at)}
        </span>
        <span className="pt-0.5 text-muted-foreground">
          <ChannelIcon entry={first} />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-[13px]">
            <span
              className={cn("font-medium", bad ? "text-destructive" : "text-warning-foreground")}
            >
              {text.title}
            </span>
            <span className="text-muted-foreground"> · {burstLabel(burst)}</span>
          </div>
          {text.note ? <div className="text-muted-foreground">{text.note}</div> : null}
        </div>
        {open ? (
          <ChevronDownIcon className="mt-0.5 size-3.5 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="mt-0.5 size-3.5 text-muted-foreground" />
        )}
      </button>
      {open ? (
        <ul className="pb-1">
          {burst.entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AutomaticGroup({ entries }: { readonly entries: ReadonlyArray<AccessEntry> }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 0) return null;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-2 text-left text-xs text-muted-foreground hover:text-foreground sm:px-5"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5" />
        ) : (
          <ChevronRightIcon className="size-3.5" />
        )}
        <CogIcon className="size-3.5" />
        {automaticLabel(entries.length)}
      </button>
      {open ? (
        <ul className="pb-1">
          {entries.map((e) => (
            <EntryRow key={e.id} entry={e} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function HowChecked() {
  const [open, setOpen] = useState(false);
  return (
    <SettingsRow
      title={
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
          How this is checked
        </button>
      }
      description={
        open ? (
          <>
            We read the computer's own login journal — you can check it yourself with{" "}
            <code className="rounded bg-muted px-1">sudo journalctl -m -t sshd</code> — and compare
            it with Uno's records of every operation we do on it. Uno's key is the one in{" "}
            <code className="rounded bg-muted px-1">/etc/ssh/uno_exec_authorized_keys</code> on the
            computer; every login with it is matched against those records. The terminal and AI
            agents inside Uno Work run within your Uno Work sessions, which are listed here.
            <br />
            <br />
            Uno's servers also record every command Uno runs inside the computer and match it to our
            records. Uno can do maintenance without asking first, and always tells you right away —
            the reason is on the entry. If Uno's key was used and we have no record, it shows here
            in red and we explain it within 24 hours. Entries are never edited: an explanation is
            added as a new entry.
          </>
        ) : (
          "Where this list comes from, and how you can check it yourself."
        )
      }
    />
  );
}

export function AccessJournal({ box }: { readonly box: UnoBox }) {
  const now = useRelativeTimeTick(60_000);
  const [filter, setFilter] = useState<AccessFilter>("all");
  const log = useQuery({
    queryKey: accessLogKey(box.id),
    queryFn: async () => (await accountRequest("GET", accessLogPath(box.id))) as AccessLogResponse,
  });
  const data = log.data;
  const entries = (data?.entries ?? []).filter((e) => matchesFilter(e, filter));
  const days = groupByDay(entries, now);
  const verdict = data ? verdictFor(data.summary) : null;
  const failed = data ? failedAttemptsLine(data.summary) : null;
  const note = data ? scanNote(data.guest_scan.status) : null;

  const refresh = (
    <Button
      size="xs"
      variant="ghost"
      disabled={log.isFetching}
      onClick={() => void log.refetch()}
      aria-label="Refresh"
    >
      <RefreshCwIcon className={cn("size-3.5", log.isFetching && "animate-spin")} />
      Refresh
    </Button>
  );

  let body: ReactNode;
  if (log.isPending) {
    body = <SettingsRow title="Reading who got in…" description="This takes a few seconds." />;
  } else if (log.isError) {
    body = <SettingsRow title="Couldn't load the journal" description={errorText(log.error)} />;
  } else {
    body = (
      <>
        {verdict ? (
          <div
            className={cn(
              "flex items-start gap-3 px-4 py-4 sm:px-5",
              verdict.tone === "good"
                ? "bg-success/6"
                : verdict.tone === "notice"
                  ? "bg-warning/8"
                  : "bg-destructive/8",
            )}
          >
            <VerdictIcon tone={verdict.tone} className="mt-0.5 size-5 shrink-0" />
            <div className="space-y-1">
              <div
                className={cn(
                  "text-[13px] font-semibold",
                  verdict.tone === "bad" && "text-destructive",
                )}
              >
                {verdict.title}
              </div>
              <div className="text-xs text-muted-foreground">{verdict.description}</div>
            </div>
          </div>
        ) : null}
        {note || failed ? (
          <div className="space-y-1 border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {note ? <div>{note}</div> : null}
            {failed ? <div>{failed}</div> : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-1.5 border-t border-border/60 px-4 py-3 sm:px-5">
          {ACCESS_FILTERS.map((f) => (
            <Button
              key={f.id}
              size="xs"
              variant={filter === f.id ? "default" : "outline"}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
            >
              {f.label}
            </Button>
          ))}
        </div>
        {days.length === 0 ? (
          <div className="border-t border-border/60 px-4 py-4 text-xs text-muted-foreground sm:px-5">
            Nothing here for the last 30 days.
          </div>
        ) : (
          days.map((day) => (
            <div key={day.key} className="border-t border-border/60 py-2">
              <div className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground sm:px-5">
                {day.label}
              </div>
              <ul>
                {collapseBursts(day.visible).map((item) =>
                  item.kind === "burst" ? (
                    <BurstRow key={item.key} burst={item} />
                  ) : (
                    <EntryRow key={item.entry.id} entry={item.entry} />
                  ),
                )}
                <AutomaticGroup entries={day.automatic} />
              </ul>
            </div>
          ))
        )}
        <HowChecked />
      </>
    );
  }

  return (
    <SettingsSection title="Who got in" headerAction={refresh}>
      {body}
    </SettingsSection>
  );
}
