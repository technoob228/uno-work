/**
 * Apps & sites (sidebar D, 0.0.105): one place with two tabs.
 *
 * - Apps: every app of the computer with its one primary action — Open, Start,
 *   Open in Telegram / Waiting for token for a bot, Show on the internet (the
 *   list the sidebar's Apps mode had, SidebarAppsList), plus the app servers.
 * - Sites: the person's sites on Uno Hosting, read by this computer's daemon
 *   (`uno.sites.list`, the console's `/api/v1/work/sites` with the machine's
 *   token), so it works on the computer's direct address too. Each site: its
 *   address, "Live", Open, Copy link, "Change with Uno", a lock when it has a
 *   password, "Made in chat …" (one click back to the chat that published
 *   it, when it was made on this computer) and Unpublish (asks first; the
 *   person's own Uno session takes it down — `unpublishSite.ts`).
 *
 * A plain site goes up without an Allow (Misha 02.10); taking it down is the
 * person's own click here, or their Allow of the agent's `site_unpublish`.
 */
import type { EnvironmentId, ThreadId, UnoWorkSites } from "@t3tools/contracts";
import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LayoutGridIcon,
  LockIcon,
  MessageSquareIcon,
  SparklesIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { consoleLinks } from "../../account/accountOverview";
import { isElectron } from "../../env";
import { useActiveMachine } from "../../hooks/useActiveMachine";
import { ensureEnvironmentApi } from "../../environmentApi";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";
import { selectEnvironmentState, useStore } from "../../store";
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
import { unpublishSite } from "./unpublishSite";
import {
  type AppsSitesTab,
  changeSitePrompt,
  siteRows,
  updatedAgo,
  type SiteRow,
} from "./sitesModel";

const NEW_SITE_PROMPT = "Make me a website. Ask me what it's for.";

function openConsoleSites() {
  const url = consoleLinks.sites;
  if (isElectron) window.open(url, "_blank");
  else window.open(url, "_blank", "noopener,noreferrer");
}

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
  const navigate = useNavigate();
  const rows = useMemo(() => siteRows(sites.data?.sites ?? []), [sites.data]);
  // The chats of "Made in chat …" as the sidebar names them now (a chat can
  // be renamed after it published; a deleted one is no link any more).
  const madeInIds = useMemo(
    () => rows.flatMap((row) => (row.madeIn ? [row.madeIn.threadId] : [])),
    [rows],
  );
  const threadTitles = useStore(
    useShallow((state) => {
      const out: Record<string, string> = {};
      if (environmentId === null) return out;
      const summaries = selectEnvironmentState(state, environmentId).sidebarThreadSummaryById;
      for (const id of madeInIds) {
        const summary = summaries[id as ThreadId];
        if (summary) out[id] = summary.title;
      }
      return out;
    }),
  );
  const madeInTitle = (row: SiteRow): string | null =>
    row.madeIn ? threadTitles[row.madeIn.threadId] || row.madeIn.title || "Chat" : null;
  const [confirming, setConfirming] = useState<SiteRow | null>(null);
  const unpublish = useMutation({
    mutationFn: (row: SiteRow) => unpublishSite(environmentId, row.slug),
    onSuccess: (result, row) => {
      setConfirming(null);
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: `Unpublish ${row.host} in the Uno console`,
          description: result.message ?? undefined,
          actionProps: { children: "Open Sites", onClick: openConsoleSites },
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
        description: error instanceof Error ? error.message : undefined,
        actionProps: { children: "Open Sites", onClick: openConsoleSites },
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
        <Button size="sm" onClick={() => void launchers.sendToUno(NEW_SITE_PROMPT)}>
          <SparklesIcon />
          Make a site with Uno
        </Button>
      </div>
    );
  }
  return (
    <>
      <div className="mb-2 flex justify-end">
        <Button
          size="xs"
          variant="outline"
          data-testid="sites-new"
          onClick={() => void launchers.sendToUno(NEW_SITE_PROMPT)}
        >
          <SquarePenIcon />
          New site
        </Button>
      </div>
      <ul className="flex flex-col gap-2" data-testid="sites-list">
        {rows.map((row) => (
          <SiteItem
            key={row.slug}
            row={row}
            madeInTitle={madeInTitle(row)}
            onOpenChat={
              row.madeIn &&
              environmentId !== null &&
              threadTitles[row.madeIn.threadId] !== undefined
                ? () =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: row.madeIn!.threadId as ThreadId },
                    })
                : null
            }
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
  madeInTitle,
  onOpenChat,
  onChange,
  onUnpublish,
}: {
  row: SiteRow;
  /** The chat that published it, by its current name; null = made elsewhere. */
  madeInTitle: string | null;
  /** Opens that chat; null when the chat is gone (the line stays as text). */
  onOpenChat: (() => void) | null;
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
        {madeInTitle !== null ? (
          onOpenChat ? (
            <button
              type="button"
              onClick={onOpenChat}
              data-testid="site-made-in"
              title="Open the chat that made this site"
              className="mt-0.5 flex max-w-full cursor-pointer items-center gap-1 text-[11px] text-primary hover:underline"
            >
              <MessageSquareIcon className="size-3 shrink-0" />
              <span className="truncate">Made in chat “{madeInTitle}”</span>
            </button>
          ) : (
            <div
              data-testid="site-made-in"
              className="mt-0.5 flex max-w-full items-center gap-1 text-[11px] text-muted-foreground"
            >
              <MessageSquareIcon className="size-3 shrink-0" />
              <span className="truncate">Made in chat “{madeInTitle}”</span>
            </div>
          )
        ) : null}
      </div>
      <span
        data-testid="site-status"
        className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
      >
        Live
      </span>
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
