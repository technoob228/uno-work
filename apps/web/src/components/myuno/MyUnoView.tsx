/**
 * "My Uno" — the top of Uno Work: everything on the account in one window.
 *
 *   Overview : built from what a person comes here to do —
 *     1. "Is everything OK?"      → "Worth a look", only when something needs a
 *                                   decision (a computer not responding, an app
 *                                   that didn't install), else one quiet line;
 *     2. "Go work on my computer" → an Uno Work row's action is Open ("You're
 *                                   here" for this one, Wake up when asleep);
 *     3. "Where is my …?"         → every row says what runs there and where it
 *                                   answers; search finds by app and address;
 *     4. "What am I paying for?"  → the plan line and ≈ $/mo on every row;
 *     5. "Add something"          → Add on Computers, Publish on Sites;
 *     6. "Manage one thing"       → a click opens the side panel (load, apps,
 *                                   logs, sleep, what it's for, the console).
 *     Rows, not cards: one line per thing. Sections: Computers → Sites →
 *     Cloud storage.
 *   Plan & billing : the plan and its usage, balance, Uno AI credits, the plan
 *     ladder and the payment history.
 *
 * Works from app.uno4.work and from the desktop app (where the computer the
 * app runs on is listed too, as "This Mac"). Reads the account as the
 * signed-in person; never through a computer's own key.
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  CloudIcon,
  GlobeIcon,
  LayoutGridIcon,
  RefreshCwIcon,
  ServerIcon,
  UploadIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import type { AccountComputer, ComputerApp, HostedSite } from "../../account/accountOverview";
import { formatBytes } from "../../account/billingModel";
import { AccountSignInRequiredError } from "../../account/unoAccount";
import { isElectron } from "../../env";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { cn } from "../../lib/utils";
import { LiteBanner } from "../../lite/LiteBanner";
import { isWebLite, liteLinks, openCloudWork } from "../../lite/webLite";
import { openInNewTab } from "../../navigation/useOpenApp";
import { useStore } from "../../store";
import { AccountSignInCta } from "../account/AccountSignInCta";
import { ChatInFolderDialog } from "../computer/ChatInFolderDialog";
import { filesApi } from "../files/filesApi";
import { Button } from "../ui/button";
import { Sheet, SheetPopup } from "../ui/sheet";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { AddComputerDialog } from "./AddComputerDialog";
import { BillingView } from "./BillingView";
import { CloudTab } from "./CloudTab";
import { ComputersTab } from "./ComputersTab";
import { ComputerDetail, PanelFrame, type PanelTab, SiteDetail } from "./DetailPanel";
import {
  type ComputerEntry,
  computerEntry,
  hasProblem,
  localEntry,
  worthALook,
} from "./myUnoModel";
import {
  accountReachable,
  balanceQuery,
  cloudQuery,
  computerAppsQuery,
  computersQuery,
  myUnoKeys,
  plansQuery,
  refreshMyUno,
  sitesQuery,
  subscriptionQuery,
} from "./myUnoQueries";
import { PlanLine, WorthALook } from "./OverviewTop";
import { SitesTab } from "./SitesTab";
import { useComputerActions } from "./useComputerActions";
import { useOpenAccountComputer } from "./useOpenAccountComputer";

const routeApi = getRouteApi("/_chat/my-uno");

export type MyUnoTab = "overview" | "billing";
type Section = "computers" | "sites" | "cloud";

type Selection =
  | { readonly kind: "computer"; readonly key: string; readonly tab: PanelTab }
  | { readonly kind: "site"; readonly slug: string };

const NO_APPS: ReadonlyArray<ComputerApp> = [];
const NO_BOXES: ReadonlyArray<AccountComputer> = [];

function signedOut(error: unknown): boolean {
  return error instanceof AccountSignInRequiredError;
}

export function MyUnoView() {
  const search = routeApi.useSearch();
  const tab: MyUnoTab = search.tab === "billing" ? "billing" : "overview";
  const section: Section = search.section ?? "computers";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const switchEnvironment = useSwitchEnvironment();
  const primary = usePrimaryEnvironmentDescriptor();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const reachable = accountReachable();
  const wide = useMediaQuery("lg");

  const computers = useQuery(computersQuery());
  const subscription = useQuery(subscriptionQuery());
  const plans = useQuery(plansQuery());
  const balance = useQuery(balanceQuery());
  const sites = useQuery(sitesQuery());
  const cloud = useQuery(cloudQuery());
  const boxes = computers.data ?? NO_BOXES;
  // What runs on each computer (App Store apps) — the row chips, the search
  // and "Worth a look" all read it. `combine` keeps the list stable between
  // renders while no query changes.
  const appsByIndex = useQueries({
    queries: boxes.map((box) => computerAppsQuery(box.id, true)),
    combine: (results) => results.map((result) => result.data),
  });

  const { open, opening, environmentFor } = useOpenAccountComputer();
  const actions = useComputerActions();
  const [addOpen, setAddOpen] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [updating, setUpdating] = useState<HostedSite | null>(null);

  const setTab = (next: MyUnoTab) =>
    void navigate({ to: "/my-uno", search: next === "billing" ? { tab: "billing" } : {} });
  const setSection = (next: Section) => {
    // The panel belongs to the section it was opened from.
    if (next !== section) setSelection(null);
    void navigate({
      to: "/my-uno",
      search: next === "computers" ? {} : { section: next },
      replace: true,
    });
  };
  const seePlans = () => setTab("billing");
  // Web lite can't pick a folder on a computer: sites are updated in the console.
  const updateSite = isWebLite
    ? (_site: HostedSite) => openInNewTab(liteLinks.publishSite)
    : setUpdating;

  const needsSignIn = !reachable || signedOut(computers.error) || signedOut(balance.error);
  const sub = subscription.data ?? null;
  const currentEnvironmentId = activeEnvironmentId ?? primary?.environmentId ?? null;
  // The desktop app's own computer: yours, listed with the Uno Work ones, free.
  const localName =
    isElectron && primary
      ? primary.platform.os === "darwin"
        ? "This Mac"
        : "This computer"
      : null;
  const primaryEnvironmentId = primary?.environmentId ?? null;
  const localHere = localName !== null && currentEnvironmentId === primaryEnvironmentId;

  const entries = useMemo(() => {
    const list: ComputerEntry[] = boxes.map((box, index) => {
      const environmentId = environmentFor(box.id);
      return computerEntry(
        box,
        appsByIndex[index] ?? NO_APPS,
        environmentId !== null && environmentId === currentEnvironmentId,
      );
    });
    if (localName) list.push(localEntry(localName, localHere));
    return list;
  }, [appsByIndex, boxes, currentEnvironmentId, environmentFor, localName, localHere]);
  const worth = useMemo(() => worthALook(entries), [entries]);

  const openEntry = useCallback(
    (entry: ComputerEntry) => {
      // Web lite has no computer to switch to: an Uno Work computer opens as
      // the full app ("/" — the backend serves it once there is one), a
      // server shows its panel (load, apps, logs, the console).
      if (isWebLite) {
        if (entry.box?.workMachine) openCloudWork();
        else if (entry.box) setSelection({ kind: "computer", key: entry.key, tab: "monitor" });
        return;
      }
      if (entry.local) {
        if (primaryEnvironmentId) switchEnvironment(primaryEnvironmentId, { landing: "computer" });
      } else if (entry.box) void open(entry.box);
    },
    [open, primaryEnvironmentId, switchEnvironment],
  );
  const openingFor = opening ? { key: `box-${opening.id}`, label: opening.label } : null;

  const selectedEntry =
    selection?.kind === "computer"
      ? (entries.find((entry) => entry.key === selection.key) ?? null)
      : null;
  const selectedSite =
    selection?.kind === "site"
      ? ((sites.data?.sites ?? []).find((site) => site.slug === selection.slug) ?? null)
      : null;
  const gone =
    selection !== null &&
    ((selection.kind === "computer" && !computers.isPending && !selectedEntry) ||
      (selection.kind === "site" && !sites.isPending && !selectedSite));
  // Deleted (or signed out) while open: close instead of showing an empty panel.
  useEffect(() => {
    if (gone) setSelection(null);
  }, [gone]);

  const selectComputer = (entry: ComputerEntry) =>
    setSelection((current) =>
      current?.kind === "computer" && current.key === entry.key
        ? null
        : { kind: "computer", key: entry.key, tab: "monitor" },
    );
  const selectSite = (site: HostedSite) =>
    setSelection((current) =>
      current?.kind === "site" && current.slug === site.slug
        ? null
        : { kind: "site", slug: site.slug },
    );

  // Esc closes the side panel (not while typing — Esc there clears the search).
  useEffect(() => {
    if (!selection || !wide) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "Escape" || target?.closest("input, textarea, [role=menu]")) return;
      setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, wide]);

  const panel =
    tab === "overview" && !needsSignIn && selection ? (
      selectedEntry && selection.kind === "computer" ? (
        <PanelFrame kind="Computer" onClose={() => setSelection(null)}>
          <ComputerDetail
            key={selectedEntry.key}
            entry={selectedEntry}
            subscription={sub}
            tab={selection.tab}
            onTab={(next) => setSelection({ ...selection, tab: next })}
            onOpen={openEntry}
            opening={openingFor?.key === selectedEntry.key ? openingFor.label : null}
            actions={actions}
          />
        </PanelFrame>
      ) : selectedSite ? (
        <PanelFrame kind="Site" onClose={() => setSelection(null)}>
          <SiteDetail site={selectedSite} onUpdate={() => updateSite(selectedSite)} />
        </PanelFrame>
      ) : null
    ) : null;

  const sections: ReadonlyArray<{
    id: Section;
    label: string;
    icon: ReactNode;
    count: string;
    bad: boolean;
  }> = [
    {
      id: "computers",
      label: "Computers",
      icon: <ServerIcon />,
      count: computers.data ? String(entries.length) : "",
      bad: entries.some(hasProblem),
    },
    {
      id: "sites",
      label: "Sites",
      icon: <GlobeIcon />,
      count: sites.data ? String(sites.data.sites.length) : "",
      bad: false,
    },
    {
      id: "cloud",
      label: "Cloud storage",
      icon: <CloudIcon />,
      count: cloud.data ? formatBytes(cloud.data.usedBytes) : "",
      bad: false,
    },
  ];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <div className="flex items-center gap-2">
            <SidebarTrigger className="size-7 shrink-0 md:hidden" />
            <LayoutGridIcon className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">My Uno</span>
            {!needsSignIn ? (
              <div className="ml-3 flex rounded-lg bg-muted/50 p-0.5" role="tablist">
                {(
                  [
                    ["overview", "Overview"],
                    ["billing", "Plan & billing"],
                  ] as const
                ).map(([key, label]) => (
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
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-1">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => refreshMyUno(queryClient)}
                aria-label="Refresh"
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 p-4 pb-16 sm:px-6 sm:pt-5">
              {needsSignIn ? (
                <section className="rounded-2xl border border-border/60 bg-card/40 p-6">
                  <h1 className="mb-1 text-lg font-semibold">Everything in one place</h1>
                  <p className="mb-4 text-sm text-muted-foreground">
                    Your computers, sites, cloud and plan live in your Uno account.
                  </p>
                  <AccountSignInCta />
                </section>
              ) : tab === "billing" ? (
                <BillingView
                  subscription={sub}
                  subscriptionLoading={subscription.isPending}
                  catalog={plans.data}
                  catalogLoading={plans.isPending}
                  balance={balance.data}
                  cloud={cloud.data}
                  sites={sites.data}
                  computers={boxes.length}
                />
              ) : (
                <>
                  {isWebLite ? (
                    <LiteBanner
                      subscription={sub}
                      loading={subscription.isPending}
                      catalog={plans.data}
                    />
                  ) : null}
                  <PlanLine
                    subscription={sub}
                    subscriptionLoading={subscription.isPending}
                    balance={balance.data}
                    onOpen={seePlans}
                  />

                  {computers.data ? (
                    <WorthALook
                      items={worth}
                      onLook={(item) => {
                        setSection("computers");
                        setSelection({
                          kind: "computer",
                          key: item.entry.key,
                          tab: item.kind === "app" ? "apps" : "monitor",
                        });
                      }}
                    />
                  ) : null}

                  <div
                    className="flex items-center gap-1 overflow-x-auto border-b border-border"
                    role="tablist"
                  >
                    {sections.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="tab"
                        aria-selected={section === item.id}
                        onClick={() => setSection(item.id)}
                        className={cn(
                          "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 pt-1 pb-2.5 text-sm transition-colors [&_svg]:size-4",
                          section === item.id
                            ? "border-primary font-medium text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground",
                        )}
                        data-testid={`my-uno-section-${item.id}`}
                      >
                        {item.icon}
                        {item.label}
                        {item.count ? (
                          <span className="text-xs font-normal tabular-nums text-muted-foreground">
                            {item.count}
                          </span>
                        ) : null}
                        {item.bad ? (
                          <span
                            className="size-1.5 rounded-full bg-destructive"
                            aria-label="needs a look"
                          />
                        ) : null}
                      </button>
                    ))}
                  </div>

                  {section === "computers" ? (
                    <ComputersTab
                      entries={entries}
                      loading={computers.isPending}
                      error={computers.error}
                      subscription={sub}
                      selectedKey={selection?.kind === "computer" ? selection.key : null}
                      onSelect={(entry) => selectComputer(entry)}
                      onOpen={openEntry}
                      opening={openingFor}
                      actions={actions}
                      onAdd={() => setAddOpen(true)}
                    />
                  ) : section === "sites" ? (
                    <SitesTab
                      data={sites.data}
                      loading={sites.isPending}
                      error={sites.error}
                      selectedSlug={selection?.kind === "site" ? selection.slug : null}
                      onSelect={selectSite}
                      onUpdate={updateSite}
                    />
                  ) : (
                    <CloudTab
                      cloud={cloud.data}
                      loading={cloud.isPending}
                      error={cloud.error}
                      subscription={sub}
                    />
                  )}
                </>
              )}
            </div>
          </div>

          {wide && panel ? (
            <aside className="flex w-[340px] shrink-0 flex-col border-l border-border">
              {panel}
            </aside>
          ) : null}
        </div>
      </div>

      {!wide ? (
        <Sheet open={panel !== null} onOpenChange={(next) => (next ? null : setSelection(null))}>
          <SheetPopup side="right" showCloseButton={false} className="max-w-sm">
            {panel}
          </SheetPopup>
        </Sheet>
      ) : null}

      <AddComputerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        subscription={sub}
        computers={boxes}
        onSeePlans={seePlans}
      />
      {actions.confirmSleep}
      {actions.confirmRestart}
      {isWebLite ? null : <UpdateSiteDialog site={updating} onClose={() => setUpdating(null)} />}
    </SidebarInset>
  );
}

/**
 * Update a site from a folder on the computer you're on — the same publish as
 * Files → Share → Publish as a website, to the same address.
 */
function UpdateSiteDialog({ site, onClose }: { site: HostedSite | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const primary = usePrimaryEnvironmentDescriptor();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primary?.environmentId ?? null;
  return (
    <ChatInFolderDialog
      environmentId={environmentId}
      open={site !== null}
      onOpenChange={(open) => (open ? null : onClose())}
      title={site ? `Update ${site.slug}` : "Update a site"}
      description="Pick the folder with the new version on this computer. Its files replace what the site shows now, at the same address."
      actionLabel={(folder) => `Publish ${folder}`}
      actionIcon={<UploadIcon />}
      errorFallback="Couldn't publish the site."
      onStart={async (folder) => {
        if (!site || !environmentId) return;
        const result = await filesApi(environmentId).publishSite({ path: folder, slug: site.slug });
        toastManager.add({
          type: "success",
          title: `${result.slug} is updated`,
          description: `${result.filesCount} files are live at ${result.url.replace(/^https?:\/\//, "")}.`,
        });
        void queryClient.invalidateQueries({ queryKey: myUnoKeys.sites });
      }}
    />
  );
}
