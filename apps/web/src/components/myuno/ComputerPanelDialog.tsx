/**
 * "Manage" a computer from My Uno — for a server without Uno Work this is the
 * whole control: how hard it's working, what's installed on it (open each app
 * inside Uno), and its logs. Everything comes from the console as the signed-in
 * person, so it works for any computer on the account, asleep or not.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { type AccountComputer, consoleLinks } from "../../account/accountOverview";
import { computerSize, formatRam } from "../../account/billingModel";
import { ROLE_BLURB } from "../../account/computerRoles";
import { cn } from "../../lib/utils";
import { openInNewTab, useOpenApp } from "../../navigation/useOpenApp";
import { computerPowerState, humanDuration } from "../computer/computerFormat";
import { Meter } from "../computer/computerUi";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Skeleton } from "../ui/skeleton";
import { RoleBadge } from "./ComputersSection";
import {
  computerAppsQuery,
  computerLogsQuery,
  computerMetricsQuery,
  myUnoKeys,
} from "./myUnoQueries";

type Tab = "monitor" | "apps" | "logs";

function pct(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.min(100, Math.round((used / total) * 100));
}

function Tile({
  label,
  value,
  sub,
  meter,
}: {
  label: string;
  value: string;
  sub?: string | undefined;
  meter: number | null;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-muted/40 px-3 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-lg font-semibold tabular-nums">{value}</span>
      {meter !== null ? <Meter value={meter} /> : null}
      {sub ? <span className="text-[11px] text-muted-foreground">{sub}</span> : null}
    </div>
  );
}

export function ComputerPanelDialog({
  computer,
  onClose,
}: {
  computer: AccountComputer | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("monitor");
  const queryClient = useQueryClient();
  const { openHere } = useOpenApp();
  const id = computer?.id ?? 0;
  const open = computer !== null;
  const on = computer ? computerPowerState(computer.status) === "on" : false;

  const metrics = useQuery(computerMetricsQuery(id, open && tab === "monitor" && on));
  const apps = useQuery(computerAppsQuery(id, open && tab === "apps"));
  const logs = useQuery(computerLogsQuery(id, open && tab === "logs" && on));

  const m = metrics.data;
  // Logs read like a terminal: newest at the bottom, in view.
  const logsRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs.data]);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: myUnoKeys.metrics(id) });
    void queryClient.invalidateQueries({ queryKey: myUnoKeys.apps(id) });
    void queryClient.invalidateQueries({ queryKey: myUnoKeys.logs(id) });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogPopup className="max-w-2xl">
        {computer ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2 pr-8">
                {computer.name}
                <RoleBadge role={computer.role} />
              </DialogTitle>
              <DialogDescription>
                {computerSize(computer.ramMb, computer.vcpu)} · {computer.diskGb} GB disk.{" "}
                {ROLE_BLURB[computer.role]}
              </DialogDescription>
            </DialogHeader>
            <DialogPanel className="flex flex-col gap-4">
              <div className="flex items-center gap-1">
                <div className="flex rounded-lg bg-muted/50 p-0.5" role="tablist">
                  {(["monitor", "apps", "logs"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={tab === key}
                      onClick={() => setTab(key)}
                      className={cn(
                        "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                        tab === key
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {key === "monitor" ? "Monitor" : key === "apps" ? "Apps" : "Logs"}
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
                  <p className="rounded-xl bg-muted/40 px-3.5 py-3 text-xs text-muted-foreground">
                    This computer is asleep, so it isn't using anything right now. Wake it up to see
                    its load.
                  </p>
                ) : metrics.isPending ? (
                  <div className="grid grid-cols-3 gap-2">
                    <Skeleton className="h-24 rounded-xl" />
                    <Skeleton className="h-24 rounded-xl" />
                    <Skeleton className="h-24 rounded-xl" />
                  </div>
                ) : metrics.isError ? (
                  <p className="text-xs text-muted-foreground">
                    Couldn't read this computer just now. It will try again in a moment.
                  </p>
                ) : m ? (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <Tile
                      label="Processor"
                      value={m.cpuPct === null ? "—" : `${Math.round(m.cpuPct)}%`}
                      meter={m.cpuPct === null ? null : Math.round(m.cpuPct)}
                      sub={`${computer.vcpu} ${computer.vcpu === 1 ? "core" : "cores"}`}
                    />
                    <Tile
                      label="Memory"
                      value={m.memUsedMb === null ? "—" : formatRam(m.memUsedMb)}
                      meter={pct(m.memUsedMb, m.memLimitMb)}
                      sub={m.memLimitMb ? `of ${formatRam(m.memLimitMb)}` : undefined}
                    />
                    <Tile
                      label="Disk"
                      value={m.diskUsedGb === null ? "—" : `${m.diskUsedGb.toFixed(1)} GB`}
                      meter={pct(m.diskUsedGb, m.diskTotalGb)}
                      sub={m.diskTotalGb ? `of ${Math.round(m.diskTotalGb)} GB` : undefined}
                    />
                    {m.uptimeS !== null ? (
                      <p className="text-xs text-muted-foreground sm:col-span-3">
                        Awake for {humanDuration(m.uptimeS)}.
                      </p>
                    ) : null}
                  </div>
                ) : null
              ) : null}

              {tab === "apps" ? (
                apps.isPending ? (
                  <Skeleton className="h-20 rounded-xl" />
                ) : apps.isError ? (
                  <p className="text-xs text-muted-foreground">Couldn't read the apps just now.</p>
                ) : (apps.data ?? []).length === 0 ? (
                  <p className="rounded-xl bg-muted/40 px-3.5 py-3 text-xs text-muted-foreground">
                    Nothing from the App Store on this computer yet.
                    {computer.workMachine
                      ? " Open the computer and use the App Store on its Home."
                      : " Ask Uno in a chat to set something up here, or add apps from its Home once Uno Work runs on it."}
                  </p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border/60 rounded-xl border border-border/60">
                    {(apps.data ?? []).map((app) => (
                      <li key={app.id} className="flex items-center gap-3 px-3 py-2.5">
                        <span className="flex size-8 items-center justify-center rounded-lg bg-muted text-base">
                          {app.icon && !app.icon.startsWith("http")
                            ? app.icon
                            : app.name.slice(0, 1)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{app.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {app.status === "running" || app.status === "ready"
                              ? (app.url ?? "Running")
                              : app.status}
                          </span>
                        </span>
                        {app.url ? (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={() => {
                              onClose();
                              openHere({ url: app.url!, name: app.name });
                            }}
                          >
                            Open
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )
              ) : null}

              {tab === "logs" ? (
                !on ? (
                  <p className="rounded-xl bg-muted/40 px-3.5 py-3 text-xs text-muted-foreground">
                    Logs come from the running computer. Wake it up to read them.
                  </p>
                ) : logs.isPending ? (
                  <Skeleton className="h-56 rounded-xl" />
                ) : logs.isError ? (
                  <p className="text-xs text-muted-foreground">Couldn't read the logs just now.</p>
                ) : (
                  <pre
                    ref={logsRef}
                    className="max-h-80 overflow-auto rounded-xl bg-muted/50 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
                    data-testid="my-uno-logs"
                  >
                    {(logs.data?.lines ?? []).length > 0
                      ? logs.data!.lines.join("\n")
                      : (logs.data?.error ?? "Nothing in the logs yet.")}
                  </pre>
                )
              ) : null}

              <p className="text-[11px] text-muted-foreground">
                For engineers: SSH, ports and the API for this computer are in the console.{" "}
                <button
                  type="button"
                  className="inline-flex items-center gap-0.5 text-primary underline-offset-4 hover:underline"
                  onClick={() => openInNewTab(consoleLinks.computer(computer.id))}
                >
                  Open in console <ExternalLinkIcon className="size-3" />
                </button>
              </p>
            </DialogPanel>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
