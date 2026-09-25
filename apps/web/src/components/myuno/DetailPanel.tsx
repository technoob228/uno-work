/**
 * The side panel of My Uno — one computer or one site in full, with
 * everything you can do to it. A computer: open / wake / sleep / restart, what it's for,
 * and its load, apps and logs (read from the console as the signed-in person,
 * so it works for any computer on the account, with or without Uno Work).
 * Resizing, deleting and SSH stay in the console, one click away.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDownIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LaptopIcon,
  Loader2Icon,
  LockIcon,
  MoonIcon,
  RefreshCwIcon,
  RotateCwIcon,
  SquareArrowOutUpRightIcon,
  SunIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import {
  type AccountSubscription,
  type HostedSite,
  consoleLinks,
} from "../../account/accountOverview";
import { computerSize, formatBytes, formatRam, formatUsd } from "../../account/billingModel";
import { ASSIGNABLE_ROLES, ROLE_BLURB, ROLE_LABEL } from "../../account/computerRoles";
import { cn } from "../../lib/utils";
import { openInNewTab, useOpenApp } from "../../navigation/useOpenApp";
import { formatElapsedAgoLabel } from "../../timestampFormat";
import { awakeLine } from "../computer/computerFormat";
import { Meter } from "../computer/computerUi";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import {
  APP_HEALTH_LABEL,
  appHealth,
  type ComputerEntry,
  entryShare,
  isAsleep,
  stateLabel,
  stateTone,
} from "./myUnoModel";
import {
  computerAppsQuery,
  computerLogsQuery,
  computerMetricsQuery,
  myUnoKeys,
} from "./myUnoQueries";
import { ROLE_ICON, ROLE_TINT, RoleBadge } from "./roleUi";
import { AppGlyph, Dot } from "./rowsUi";
import { SiteCopyButton, siteHost } from "./SitesTab";
import type { ComputerActions } from "./useComputerActions";

export type PanelTab = "monitor" | "apps" | "logs";

export function PanelFrame({
  kind,
  onClose,
  children,
}: {
  kind: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="my-uno-panel">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          {kind}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Close"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-10">{children}</div>
    </div>
  );
}

function Block({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-border/60 px-4 py-3.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        {right ? <div className="ml-auto flex items-center">{right}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium tabular-nums">{children}</span>
    </div>
  );
}

function ConsoleLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <button
      type="button"
      className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
      onClick={() => openInNewTab(href)}
    >
      {children}
      <ExternalLinkIcon className="size-3" />
    </button>
  );
}

// ---- computer ----

export function ComputerDetail({
  entry,
  subscription,
  tab,
  onTab,
  onOpen,
  opening,
  actions,
}: {
  entry: ComputerEntry;
  subscription: AccountSubscription | null;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
  onOpen: (entry: ComputerEntry) => void;
  opening: string | null;
  actions: ComputerActions;
}) {
  const box = entry.box;
  const pending = box ? actions.pending(box.id) : null;
  const restarting = box ? actions.restarting(box.id) : false;
  const awake = box ? awakeLine({ status: box.status, startedAt: box.startedAt }) : null;
  const share = entryShare(entry, subscription);
  const asleep = isAsleep(entry);

  return (
    <>
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3.5">
        <div className="flex items-start gap-3">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-4.5",
              ROLE_TINT[entry.role],
            )}
          >
            {entry.local ? <LaptopIcon /> : ROLE_ICON[entry.role]}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold" title={entry.name}>
                {entry.name}
              </span>
              {entry.here ? (
                <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                  you're here
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {box && !entry.work ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <button
                        type="button"
                        className="inline-flex items-center gap-0.5 rounded-full hover:opacity-80 disabled:opacity-60"
                        aria-label="Change what this computer is for"
                        disabled={pending === "role"}
                      />
                    }
                  >
                    <RoleBadge role={entry.role} />
                    {pending === "role" ? (
                      <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
                    ) : (
                      <ChevronDownIcon className="size-3 text-muted-foreground" />
                    )}
                  </MenuTrigger>
                  <MenuPopup align="start" className="w-[19rem]">
                    <MenuGroup>
                      <MenuGroupLabel>What is this computer for?</MenuGroupLabel>
                      {ASSIGNABLE_ROLES.map((option) => (
                        <MenuItem key={option} onClick={() => actions.setRole(box, option)}>
                          <span className="flex w-full items-start gap-2">
                            <span className="mt-0.5 text-muted-foreground [&_svg]:size-3.5">
                              {ROLE_ICON[option]}
                            </span>
                            <span className="flex min-w-0 flex-1 flex-col">
                              <span className="font-medium">
                                {ROLE_LABEL[option]}
                                {option === entry.role ? " · current" : ""}
                              </span>
                              <span className="text-xs text-muted-foreground">
                                {ROLE_BLURB[option]}
                              </span>
                            </span>
                          </span>
                        </MenuItem>
                      ))}
                    </MenuGroup>
                  </MenuPopup>
                </Menu>
              ) : (
                <RoleBadge role={entry.role} />
              )}
              <span className="inline-flex items-center gap-1.5 text-xs">
                <Dot tone={restarting ? "busy" : stateTone(entry)} />
                {restarting ? "Restarting · back in about 15 s" : stateLabel(entry)}
                {awake && entry.state === "on" && !restarting ? (
                  <span className="text-muted-foreground">· {awake}</span>
                ) : null}
              </span>
            </div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {entry.local
            ? "Your own computer with Uno Work. It is not part of the plan and costs nothing."
            : box?.note || ROLE_BLURB[entry.role]}
        </p>

        {entry.broken && box ? (
          <p className="rounded-lg bg-destructive/8 px-3 py-2 text-xs text-destructive-foreground">
            Uno lost contact with {entry.name}. Its disk is kept, but it can't be restarted from
            here.{" "}
            <ConsoleLink href={consoleLinks.computer(box.id)}>See it in the console</ConsoleLink>
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-1.5">
          {entry.work && !asleep ? (
            <Button
              size="sm"
              onClick={() => onOpen(entry)}
              disabled={entry.state !== "on" || entry.broken || opening !== null}
            >
              {opening ? <Loader2Icon className="animate-spin" /> : <SquareArrowOutUpRightIcon />}
              {opening ?? (entry.here ? "Go to its Home" : "Open")}
            </Button>
          ) : null}
          {box && asleep ? (
            <Button
              size="sm"
              variant={entry.work ? "default" : "outline"}
              disabled={pending !== null}
              onClick={() => actions.bringBack(box)}
            >
              {pending === "wake" || pending === "start" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <SunIcon />
              )}
              Wake up
            </Button>
          ) : null}
          {box && entry.state === "on" && !entry.broken ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null}
              onClick={() => actions.sleep(box, entry.here)}
            >
              {pending === "sleep" ? <Loader2Icon className="animate-spin" /> : <MoonIcon />}
              Put to sleep
            </Button>
          ) : null}
          {box && (restarting || (entry.state === "on" && !entry.broken)) ? (
            <Button
              size="sm"
              variant="outline"
              disabled={pending !== null || restarting}
              onClick={() => actions.restart(box, entry.here)}
              data-testid="myuno-restart"
            >
              {restarting ? <Loader2Icon className="animate-spin" /> : <RotateCwIcon />}
              {restarting ? "Restarting…" : "Restart"}
            </Button>
          ) : null}
        </div>
      </div>

      {box ? (
        <>
          <ComputerLive entry={entry} tab={tab} onTab={onTab} />
          <Block title="Size & cost">
            <Fact label="Size">
              {computerSize(box.ramMb, box.vcpu)} · {box.diskGb} GB disk
            </Fact>
            <Fact label="Costs">
              {share === null ? (
                "Included in your plan"
              ) : (
                <>
                  ≈ {formatUsd(share)}/mo{" "}
                  <span className="font-normal text-muted-foreground">of your plan</span>
                </>
              )}
            </Fact>
            {box.createdAt ? (
              <Fact label="Added">{formatElapsedAgoLabel(box.createdAt)}</Fact>
            ) : null}
          </Block>
          <p className="px-4 pt-1 text-[11px] leading-relaxed text-muted-foreground">
            Resize, delete, SSH and ports are in the console.{" "}
            <ConsoleLink href={consoleLinks.computer(box.id)}>Open in console</ConsoleLink>
          </p>
        </>
      ) : null}
    </>
  );
}

function pct(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.min(100, Math.round((used / total) * 100));
}

function Gauge({
  label,
  value,
  detail,
  meter,
}: {
  label: string;
  value: string;
  detail?: string | undefined;
  meter: number | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          <span className="font-medium">{value}</span>
          {detail ? <span className="text-muted-foreground"> · {detail}</span> : null}
        </span>
      </div>
      {meter !== null ? <Meter value={meter} /> : null}
    </div>
  );
}

/** Monitor / Apps / Logs of one computer — what "Manage" used to open. */
function ComputerLive({
  entry,
  tab,
  onTab,
}: {
  entry: ComputerEntry;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) {
  const queryClient = useQueryClient();
  const { openHere } = useOpenApp();
  const box = entry.box!;
  const on = entry.state === "on" && !entry.broken;
  const metrics = useQuery(computerMetricsQuery(box.id, tab === "monitor" && on));
  const apps = useQuery(computerAppsQuery(box.id, tab === "apps"));
  const logs = useQuery(computerLogsQuery(box.id, tab === "logs" && on));
  const m = metrics.data;
  const appList = apps.data ?? entry.apps;

  // Logs read like a terminal: newest at the bottom, in view.
  const logsRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.data]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: myUnoKeys.metrics(box.id) });
    void queryClient.invalidateQueries({ queryKey: myUnoKeys.apps(box.id) });
    void queryClient.invalidateQueries({ queryKey: myUnoKeys.logs(box.id) });
  };

  const offText = entry.broken
    ? "No numbers — it isn't answering."
    : "Asleep: nothing running, memory kept on disk. Wake it up to see its load.";

  return (
    <section className="flex flex-col gap-3 border-t border-border/60 px-4 py-3.5">
      <div className="flex items-center gap-1">
        <div className="flex rounded-lg bg-muted/50 p-0.5" role="tablist">
          {(["monitor", "apps", "logs"] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => onTab(key)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                tab === key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {key === "monitor" ? "Right now" : key === "apps" ? "Apps" : "Logs"}
              {key === "apps" && appList.length > 0 ? (
                <span className="ml-1 tabular-nums text-muted-foreground">{appList.length}</span>
              ) : null}
            </button>
          ))}
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          className="ml-auto"
          aria-label="Refresh"
          onClick={refresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>

      {tab === "monitor" ? (
        !on ? (
          <p className="text-xs text-muted-foreground">{offText}</p>
        ) : metrics.isPending ? (
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-7 rounded-md" />
            <Skeleton className="h-7 rounded-md" />
            <Skeleton className="h-7 rounded-md" />
          </div>
        ) : metrics.isError || !m ? (
          <p className="text-xs text-muted-foreground">
            Couldn't read this computer just now. It will try again in a moment.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5" data-testid="my-uno-monitor">
            <Gauge
              label="Processor"
              value={m.cpuPct === null ? "—" : `${Math.round(m.cpuPct)}%`}
              detail={`${box.vcpu} ${box.vcpu === 1 ? "core" : "cores"}`}
              meter={m.cpuPct === null ? null : Math.round(m.cpuPct)}
            />
            <Gauge
              label="Memory"
              value={m.memUsedMb === null ? "—" : formatRam(m.memUsedMb)}
              detail={m.memLimitMb ? `of ${formatRam(m.memLimitMb)}` : undefined}
              meter={pct(m.memUsedMb, m.memLimitMb)}
            />
            <Gauge
              label="Disk"
              value={m.diskUsedGb === null ? "—" : `${m.diskUsedGb.toFixed(1)} GB`}
              detail={m.diskTotalGb ? `of ${Math.round(m.diskTotalGb)} GB` : undefined}
              meter={pct(m.diskUsedGb, m.diskTotalGb)}
            />
          </div>
        )
      ) : null}

      {tab === "apps" ? (
        apps.isPending && entry.apps.length === 0 ? (
          <Skeleton className="h-16 rounded-xl" />
        ) : apps.isError && appList.length === 0 ? (
          <p className="text-xs text-muted-foreground">Couldn't read the apps just now.</p>
        ) : appList.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing from the App Store on this computer yet.
            {entry.work
              ? " Open the computer and use the App Store on its Home."
              : " Ask Uno in a chat to set something up here."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {appList.map((app) => {
              const health = appHealth(app.status);
              return (
                <li key={app.id} className="flex items-center gap-2.5 py-1 text-xs">
                  <AppGlyph app={app} className="size-6 bg-muted text-xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{app.name}</span>
                    <span
                      className={cn(
                        "block truncate",
                        health === "failed"
                          ? "text-destructive-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {health === "running" && app.url
                        ? app.url.replace(/^https?:\/\//, "")
                        : APP_HEALTH_LABEL[health]}
                    </span>
                  </span>
                  {app.url && health === "running" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => openHere({ url: app.url!, name: app.name })}
                    >
                      Open
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : null}

      {tab === "logs" ? (
        !on ? (
          <p className="text-xs text-muted-foreground">
            {entry.broken
              ? "Logs come from the running computer, and this one isn't answering."
              : "Logs come from the running computer. Wake it up to read them."}
          </p>
        ) : logs.isPending ? (
          <Skeleton className="h-48 rounded-xl" />
        ) : logs.isError ? (
          <p className="text-xs text-muted-foreground">Couldn't read the logs just now.</p>
        ) : (
          <pre
            ref={logsRef}
            className="max-h-72 overflow-auto rounded-xl bg-muted/50 p-2.5 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap"
            data-testid="my-uno-logs"
          >
            {(logs.data?.lines ?? []).length > 0
              ? logs.data!.lines.join("\n")
              : (logs.data?.error ?? "Nothing in the logs yet.")}
          </pre>
        )
      ) : null}
    </section>
  );
}

// ---- site ----

export function SiteDetail({ site, onUpdate }: { site: HostedSite; onUpdate: () => void }) {
  const { openHere } = useOpenApp();
  return (
    <>
      <div className="flex flex-col gap-3 px-4 pt-4 pb-3.5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500 [&_svg]:size-4.5">
            <GlobeIcon />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-base font-semibold">{site.slug}</span>
              {site.hasPassword ? (
                <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : null}
            </div>
            <div className="mt-0.5 truncate text-xs text-muted-foreground">{siteHost(site)}</div>
          </div>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          On Uno Hosting — it stays up even when every computer sleeps.
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => openHere({ url: site.url, name: site.slug })}>
            <SquareArrowOutUpRightIcon />
            Open
          </Button>
          <SiteCopyButton site={site} withLabel />
          <Button size="sm" variant="ghost" onClick={onUpdate}>
            <UploadIcon />
            Update
          </Button>
        </div>
      </div>
      <Block title="Address">
        {site.customDomain ? null : <Fact label="Link">{siteHost(site)}</Fact>}
        <Fact label="Own domain">
          {site.customDomain ?? <span className="font-normal text-muted-foreground">None</span>}
        </Fact>
        <Fact label="Who can open it">
          {site.hasPassword ? "People with the password" : "Anyone with the link"}
        </Fact>
      </Block>
      <Block title="Files">
        <Fact label="Size">
          {formatBytes(site.sizeBytes)} · {site.filesCount}{" "}
          {site.filesCount === 1 ? "file" : "files"}
        </Fact>
        {site.updatedAt ? (
          <Fact label="Updated">{formatElapsedAgoLabel(site.updatedAt)}</Fact>
        ) : null}
        {site.expiresAt ? (
          <Fact label="Expires">{new Date(site.expiresAt).toLocaleDateString()}</Fact>
        ) : null}
      </Block>
      <p className="px-4 pt-1 text-[11px] leading-relaxed text-muted-foreground">
        A password, your own domain and deleting the site are in the console.{" "}
        <ConsoleLink href={consoleLinks.sites}>Open in console</ConsoleLink>
      </p>
    </>
  );
}
