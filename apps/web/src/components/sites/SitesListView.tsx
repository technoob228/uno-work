/**
 * Apps & sites (sidebar D, 0.0.105): one place with two tabs.
 *
 * - Apps: every app of the computer with its one primary action — Open, Start,
 *   Open in Telegram / Waiting for token for a bot, Show on the internet (the
 *   list the sidebar's Apps mode had, SidebarAppsList), plus the app servers.
 * - Sites: the person's sites on Uno Hosting, read by this computer's daemon
 *   (`uno.sites.list`, the console's `/api/v1/work/sites` with the machine's
 *   token), so it works on the computer's direct address too. Each site: its
 *   address, Open, Copy link, "Change with Uno", a lock when it has a
 *   password, and Unpublish (asks first; `uno.sites.unpublish`).
 *
 * A plain site goes up without an Allow (Misha 02.10); taking it down is the
 * person's own click here.
 */
import type { EnvironmentId, UnoWorkSites } from "@t3tools/contracts";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LayoutGridIcon,
  LockIcon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { useActiveMachine } from "../../hooks/useActiveMachine";
import { ensureEnvironmentApi } from "../../environmentApi";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";
import { useHomeLaunchers } from "../computer/useHomeLaunchers";
import { SidebarAppsList } from "../sidebar/SidebarAppsList";
import { SidebarShowButton } from "../sidebar/SidebarShowButton";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SidebarInset } from "../ui/sidebar";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import {
  type AppsSitesTab,
  changeSitePrompt,
  siteRows,
  updatedAgo,
  type SiteRow,
} from "./sitesModel";

export function SitesListView() {
  const search = useSearch({ strict: false }) as { tab?: AppsSitesTab };
  const navigate = useNavigate();
  const tab: AppsSitesTab = search.tab ?? "apps";
  const machine = useActiveMachine();
  const environmentId = machine.environmentId;
  const sites = useQuery({
    queryKey: ["uno-sites", environmentId] as const,
    queryFn: () => ensureEnvironmentApi(environmentId!).unoComputer.workSites(),
    enabled: environmentId !== null,
    refetchInterval: 60_000,
  });
  const siteCount = sites.data?.availability === "ok" ? sites.data.sites.length : null;
  const setTab = (next: AppsSitesTab) => void navigate({ to: "/sites", search: { tab: next } });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <header className="shrink-0 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-3">
            <SidebarShowButton />
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white">
              <LayoutGridIcon className="size-4.5" />
            </span>
            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight">Apps &amp; sites</h1>
              <p className="truncate text-xs text-muted-foreground">
                What runs on your computer, and your websites on Uno
              </p>
            </div>
          </div>
          <div
            role="tablist"
            aria-label="Apps and sites"
            className="mt-3 -mb-2 flex gap-1 sm:-mb-3"
          >
            {(
              [
                { id: "apps", label: "Apps", count: null },
                { id: "sites", label: "Sites", count: siteCount },
              ] as const
            ).map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                aria-selected={tab === entry.id}
                data-testid={`apps-sites-tab-${entry.id}`}
                onClick={() => setTab(entry.id)}
                className={cn(
                  "-mb-px inline-flex cursor-pointer items-center gap-1.5 border-b-2 px-3 pb-2 text-sm transition-colors",
                  tab === entry.id
                    ? "border-foreground font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {entry.label}
                {entry.count !== null ? (
                  <span className="text-xs text-muted-foreground tabular-nums">{entry.count}</span>
                ) : null}
              </button>
            ))}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
            {tab === "apps" ? (
              <div className="flex flex-1 flex-col" data-testid="apps-list">
                <SidebarAppsList />
              </div>
            ) : (
              <SitesList environmentId={environmentId} sites={sites} />
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

function SitesList({
  environmentId,
  sites,
}: {
  environmentId: EnvironmentId | null;
  sites: UseQueryResult<UnoWorkSites>;
}) {
  const launchers = useHomeLaunchers(environmentId);
  const queryClient = useQueryClient();
  const rows = useMemo(() => siteRows(sites.data?.sites ?? []), [sites.data]);
  const [confirming, setConfirming] = useState<SiteRow | null>(null);
  const unpublish = useMutation({
    mutationFn: (row: SiteRow) =>
      ensureEnvironmentApi(environmentId!).unoComputer.workSiteUnpublish({ slug: row.slug }),
    onSuccess: (result, row) => {
      setConfirming(null);
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: "Couldn't unpublish",
          description: result.message ?? undefined,
        });
        return;
      }
      toastManager.add({ type: "success", title: `${row.host} is off the internet` });
      void queryClient.invalidateQueries({ queryKey: ["uno-sites", environmentId] });
    },
    onError: (error) => {
      setConfirming(null);
      toastManager.add({
        type: "error",
        title: "Couldn't unpublish",
        description:
          error instanceof Error && /unknown|not found|method/i.test(error.message)
            ? "This computer needs the latest Uno Work for that. Unpublish it in the Uno console."
            : error instanceof Error
              ? error.message
              : undefined,
      });
    },
  });

  if (sites.isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (sites.data && sites.data.availability !== "ok") {
    return <p className="py-10 text-center text-sm text-muted-foreground">{sites.data.message}</p>;
  }
  if (sites.isError) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Couldn't load your sites. Try again in a moment.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
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
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-2" data-testid="sites-list">
        {rows.map((row) => (
          <SiteItem
            key={row.slug}
            row={row}
            onChange={() => void launchers.sendToUno(changeSitePrompt(row))}
            onUnpublish={() => setConfirming(row)}
          />
        ))}
      </ul>
      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open && !unpublish.isPending) setConfirming(null);
        }}
      >
        <DialogPopup className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Unpublish {confirming?.host}?</DialogTitle>
            <DialogDescription>
              The address stops working for everyone and the site's files are removed from Uno. The
              folder on your computer stays — publish it again any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={unpublish.isPending}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={unpublish.isPending}
              data-testid="site-unpublish-confirm"
              onClick={() => {
                if (confirming) unpublish.mutate(confirming);
              }}
            >
              Unpublish
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function SiteItem({
  row,
  onChange,
  onUnpublish,
}: {
  row: SiteRow;
  onChange: () => void;
  onUnpublish: () => void;
}) {
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
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={`Unpublish ${row.host}`}
        title="Unpublish"
        data-testid="site-unpublish"
        onClick={onUnpublish}
      >
        <Trash2Icon />
      </Button>
      <Button size="xs" variant="outline" onClick={() => openInNewTab(row.url)}>
        <ExternalLinkIcon />
        Open
      </Button>
    </li>
  );
}
