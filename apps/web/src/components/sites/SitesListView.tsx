/**
 * Sites — the person's sites on Uno Hosting, inside Uno Work. The list comes
 * from this computer's daemon (`uno.sites.list`, the console's
 * `/api/v1/work/sites` with the machine's token), so it works on the
 * computer's direct address too, not only through app.uno4.work.
 *
 * Each site: its address, Open (new tab), Copy link, "Change with Uno" (a
 * chat that edits and republishes it), a lock when it has a password.
 * Mounted at `/sites` (no sidebar item yet — where Sites lives in the sidebar
 * is Misha's call).
 */
import { useQuery } from "@tanstack/react-query";
import { CopyIcon, ExternalLinkIcon, GlobeIcon, LockIcon, SparklesIcon } from "lucide-react";
import { useMemo } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { ensureEnvironmentApi } from "../../environmentApi";
import { openInNewTab } from "../../navigation/useOpenApp";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { changeSitePrompt, siteRows, updatedAgo, type SiteRow } from "./sitesModel";

export function SitesListView() {
  const machine = useActiveMachine();
  const environmentId = machine.environmentId;
  const launchers = useHomeLaunchers(environmentId);
  const sites = useQuery({
    queryKey: ["uno-sites", environmentId] as const,
    queryFn: () => ensureEnvironmentApi(environmentId!).unoComputer.workSites(),
    enabled: environmentId !== null,
    refetchInterval: 60_000,
  });
  const rows = useMemo(() => siteRows(sites.data?.sites ?? []), [sites.data]);

  const body = sites.isLoading ? (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  ) : sites.data && sites.data.availability !== "ok" ? (
    <p className="py-10 text-center text-sm text-muted-foreground">{sites.data.message}</p>
  ) : sites.isError ? (
    <p className="py-10 text-center text-sm text-muted-foreground">
      Couldn't load your sites. Try again in a moment.
    </p>
  ) : rows.length === 0 ? (
    <div className="flex flex-col items-center gap-3 py-12 text-center">
      <p className="text-sm text-muted-foreground">No sites yet.</p>
      <Button
        size="sm"
        onClick={() => void launchers.sendToUno("Make me a website. Ask me what it's for.")}
      >
        <SparklesIcon />
        Make a site with Uno
      </Button>
    </div>
  ) : (
    <ul className="flex flex-col gap-2" data-testid="sites-list">
      {rows.map((row) => (
        <SiteItem
          key={row.slug}
          row={row}
          onChange={() => void launchers.sendToUno(changeSitePrompt(row))}
        />
      ))}
    </ul>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-3">
            <SidebarShowButton />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white">
              <GlobeIcon className="size-4.5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight">Sites</h1>
              <p className="truncate text-xs text-muted-foreground">
                Your websites on Uno — live on the internet
              </p>
            </div>
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto w-full max-w-3xl">{body}</div>
        </div>
      </div>
    </SidebarInset>
  );
}

function SiteItem({ row, onChange }: { row: SiteRow; onChange: () => void }) {
  const ago = updatedAgo(row.updatedAt);
  return (
    <li
      className="flex min-w-0 items-center gap-3 rounded-xl border border-border/80 bg-card px-3 py-2.5"
      data-testid="site-row"
    >
      <GlobeIcon className="size-4 shrink-0 text-primary" />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{row.host}</span>
          {row.hasPassword ? (
            <LockIcon className="size-3 shrink-0 text-muted-foreground" aria-label="Password" />
          ) : null}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {[row.hasPassword ? "Password-protected" : "Public", ago ? `updated ${ago}` : null]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <Button size="xs" variant="ghost" onClick={onChange} title="Change it with Uno">
        <SparklesIcon />
        <span className="max-sm:hidden">Change with Uno</span>
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy link"
        title="Copy link"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(row.url)
            .then(() => toastManager.add({ type: "success", title: "Link copied" }))
            .catch(() => undefined);
        }}
      >
        <CopyIcon />
      </Button>
      <Button size="xs" variant="outline" onClick={() => openInNewTab(row.url)}>
        <ExternalLinkIcon />
        Open
      </Button>
    </li>
  );
}
