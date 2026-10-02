/**
 * "On the internet" in Apps mode: the person's app servers — bots and
 * backends that run on their own small sleeping server on Uno, not on this
 * computer. A row opens the app's address; a version the agent sent shows
 * "Allow in Uno" — Allow, rollback and the bot token live only in the Uno
 * console (a browser session), never here, so an agent on this computer can't
 * approve its own code or see the token.
 */
import { useQuery, queryOptions } from "@tanstack/react-query";
import { GlobeIcon } from "lucide-react";
import { memo } from "react";

import { CONSOLE_URL } from "../../account/accountOverview";
import { accountRequest, accountTransport } from "../../account/unoAccount";
import { cn } from "../../lib/utils";

interface AppServerRow {
  readonly id: number;
  readonly name: string;
  readonly state: string;
  readonly url: string | null;
  readonly liveVersion: number | null;
  readonly pending: { version: number; status: string } | null;
}

interface AppServersState {
  readonly enabled: boolean;
  readonly usedHours: number;
  readonly limitHours: number;
  readonly servers: ReadonlyArray<AppServerRow>;
}

export function parseAppServers(raw: unknown): AppServersState {
  const r = (raw ?? {}) as Record<string, unknown>;
  const limits = (r.limits ?? {}) as Record<string, unknown>;
  const servers = Array.isArray(r.servers) ? r.servers : [];
  return {
    enabled: r.enabled === true,
    usedHours: Number(r.used_hours ?? 0),
    limitHours: Number(limits.hours ?? 0) + Number(r.extra_hours ?? 0),
    servers: servers.map((raw) => {
      const s = raw as Record<string, unknown>;
      const live = (s.live ?? null) as Record<string, unknown> | null;
      const pending = (s.pending ?? null) as Record<string, unknown> | null;
      return {
        id: Number(s.id),
        name: String(s.name ?? ""),
        state: String(s.state ?? ""),
        url: typeof s.url === "string" ? s.url : null,
        liveVersion: live ? Number(live.version) : null,
        pending: pending
          ? { version: Number(pending.version), status: String(pending.status) }
          : null,
      };
    }),
  };
}

export const appServersQuery = () =>
  queryOptions({
    queryKey: ["workspace", "appServers"] as const,
    queryFn: async () =>
      parseAppServers(await accountRequest("GET", "/api/v1/app-servers")),
    enabled: accountTransport() !== "none",
    refetchInterval: 15_000,
    retry: false,
  });

export function appServerLine(s: AppServerRow): string {
  if (s.pending?.status === "pending_approval")
    return `Version ${s.pending.version} waits for your OK`;
  if (s.pending?.status === "deploying")
    return `Version ${s.pending.version} is going live`;
  switch (s.state) {
    case "sleeping":
      return "Sleeping · wakes on the next request";
    case "working":
      return "Working";
    case "starting":
      return "Starting";
    case "out_of_hours":
      return "Asleep until next month — hours used up";
  }
  return s.state;
}

const DOT: Record<string, string> = {
  working: "bg-emerald-500",
  sleeping: "bg-sky-400",
  starting: "bg-amber-400",
  out_of_hours: "bg-red-500",
};

export const SidebarAppServers = memo(function SidebarAppServers() {
  const { data } = useQuery(appServersQuery());
  if (!data?.enabled || data.servers.length === 0) return null;
  return (
    <section
      className="mt-2 flex flex-col gap-px"
      data-testid="sidebar-app-servers"
    >
      <div className="flex items-baseline justify-between px-2 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        <span>On the internet</span>
        <span className="normal-case tracking-normal">
          {data.usedHours.toFixed(1)} / {data.limitHours} h
        </span>
      </div>
      {data.servers.map((s) => {
        const waits = s.pending?.status === "pending_approval";
        return (
          <div
            key={s.id}
            className="group/app flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-sidebar-row-hover"
          >
            <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />
            <a
              href={s.url ?? `${CONSOLE_URL}/app-servers`}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1"
              title={s.url ?? undefined}
            >
              <div className="flex items-center gap-1.5 truncate text-sm">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    DOT[s.state] ?? "bg-muted-foreground",
                  )}
                />
                <span className="truncate">{s.name}</span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {appServerLine(s)}
              </div>
            </a>
            {waits ? (
              <a
                href={`${CONSOLE_URL}/app-servers`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded-md bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground"
              >
                Allow in Uno
              </a>
            ) : (
              <a
                href={`${CONSOLE_URL}/app-servers`}
                target="_blank"
                rel="noopener noreferrer"
                className="hidden shrink-0 text-[11px] text-muted-foreground group-hover/app:inline"
              >
                Manage
              </a>
            )}
          </div>
        );
      })}
    </section>
  );
});
