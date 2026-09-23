/**
 * "My Uno" — the top of Uno Work: everything on the account in one window.
 *
 *   Overview : computers (role, on/asleep, size, what runs, what it costs;
 *              open, wake, sleep, manage, change role, add), sites on Uno
 *              Hosting, the cloud, and a line about the plan and credits;
 *   Plan & billing : the plan and its usage, balance, Uno AI credits, the plan
 *              ladder and the payment history.
 *
 * Works from app.uno4.work and from the desktop app (where the computer the
 * app runs on is listed first). Reads the account as the signed-in person;
 * never through a computer's own key.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  LayoutGridIcon,
  RefreshCwIcon,
  SparklesIcon,
  WalletIcon,
} from "lucide-react";
import { useState } from "react";

import { type AccountComputer } from "../../account/accountOverview";
import { formatUsd, planTitle } from "../../account/billingModel";
import { AccountSignInRequiredError } from "../../account/unoAccount";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { isElectron } from "../../env";
import { useSwitchEnvironment } from "../../hooks/useSwitchEnvironment";
import { cn } from "../../lib/utils";
import { AccountSignInCta } from "../account/AccountSignInCta";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { AddComputerDialog } from "./AddComputerDialog";
import { BillingView } from "./BillingView";
import { ComputerPanelDialog } from "./ComputerPanelDialog";
import { ComputersSection } from "./ComputersSection";
import {
  accountReachable,
  balanceQuery,
  cloudQuery,
  computersQuery,
  plansQuery,
  refreshMyUno,
  sitesQuery,
  subscriptionQuery,
} from "./myUnoQueries";
import { CloudCard, SitesSection } from "./SitesSection";

const routeApi = getRouteApi("/_chat/my-uno");

export type MyUnoTab = "overview" | "billing";

function signedOut(error: unknown): boolean {
  return error instanceof AccountSignInRequiredError;
}

export function MyUnoView() {
  const search = routeApi.useSearch();
  const tab: MyUnoTab = search.tab === "billing" ? "billing" : "overview";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const switchEnvironment = useSwitchEnvironment();
  const primary = usePrimaryEnvironmentDescriptor();
  const reachable = accountReachable();

  const computers = useQuery(computersQuery());
  const subscription = useQuery(subscriptionQuery());
  const plans = useQuery(plansQuery());
  const balance = useQuery(balanceQuery());
  const sites = useQuery(sitesQuery());
  const cloud = useQuery(cloudQuery());

  const [addOpen, setAddOpen] = useState(false);
  const [managed, setManaged] = useState<AccountComputer | null>(null);

  const setTab = (next: MyUnoTab) =>
    void navigate({ to: "/my-uno", search: next === "billing" ? { tab: "billing" } : {} });
  const seePlans = () => setTab("billing");

  const needsSignIn = !reachable || signedOut(computers.error) || signedOut(balance.error);
  const sub = subscription.data ?? null;
  const planName = sub ? planTitle(sub.limits, sub.plan) : "Free";
  // The desktop app's own computer: yours, listed first, costs nothing.
  const local =
    isElectron && primary
      ? {
          name: primary.platform.os === "darwin" ? "This Mac" : "This computer",
          onOpen: () => switchEnvironment(primary.environmentId, { landing: "computer" }),
        }
      : null;
  // Keep the card of the computer being managed fresh (status after wake/sleep).
  const managedLive = managed
    ? ((computers.data ?? []).find((c) => c.id === managed.id) ?? managed)
    : null;

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

        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
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
                computers={(computers.data ?? []).length}
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setTab("billing")}
                  className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-border/60 bg-card/40 px-4 py-3 text-left transition-colors hover:bg-accent/40"
                  data-testid="my-uno-plan-strip"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <SparklesIcon className="size-4 text-primary" />
                    <span className="font-medium">{subscription.isPending ? "…" : planName}</span>
                    {sub && sub.priceUsd > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {formatUsd(sub.priceUsd)}/mo
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <WalletIcon className="size-4 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Balance</span>
                    <span className="font-medium tabular-nums">
                      {balance.data ? formatUsd(balance.data.balanceUsd) : "…"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2 text-sm">
                    <span className="text-xs text-muted-foreground">Uno AI credits</span>
                    <span className="font-medium tabular-nums">
                      {balance.data ? formatUsd(balance.data.aiBalanceUsd) : "…"}
                    </span>
                  </span>
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    Plan & billing
                    <ChevronRightIcon className="size-3.5" />
                  </span>
                </button>

                <ComputersSection
                  computers={computers.data ?? []}
                  loading={computers.isPending}
                  subscription={sub}
                  local={local}
                  onAdd={() => setAddOpen(true)}
                  onManage={setManaged}
                />

                <SitesSection data={sites.data} loading={sites.isPending} error={sites.error} />

                <section className="flex flex-col gap-3" aria-labelledby="my-uno-cloud-title">
                  <h2 id="my-uno-cloud-title" className="text-sm font-semibold">
                    Cloud
                  </h2>
                  <CloudCard data={cloud.data} planCloudGb={sub?.limits?.cloudGb ?? null} />
                </section>
              </>
            )}
          </div>
        </div>
      </div>

      <AddComputerDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        subscription={sub}
        computers={computers.data ?? []}
        onSeePlans={seePlans}
      />
      <ComputerPanelDialog computer={managedLive} onClose={() => setManaged(null)} />
    </SidebarInset>
  );
}
