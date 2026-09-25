/**
 * "Plan & billing" inside Uno Work: the plan you're on, what it includes and
 * how much of it is used, the balance and Uno AI credits, the same plan ladder
 * the console sells, and the history of money in and out.
 *
 * Everything is shown here. Money moves in the console — "Add money" and
 * "Switch" open console billing in the browser, where you're already signed
 * in — so nothing on a computer can spend on your behalf.
 */
import { useQuery } from "@tanstack/react-query";
import {
  ArrowDownLeftIcon,
  ArrowUpRightIcon,
  CheckIcon,
  CreditCardIcon,
  ExternalLinkIcon,
  SparklesIcon,
  WalletIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  type AccountBalance,
  type AccountPlan,
  type AccountSubscription,
  type CloudUsage,
  type PlanCatalog,
  type SitesState,
  consoleLinks,
} from "../../account/accountOverview";
import {
  type PlanRung,
  computerSize,
  findPlan,
  formatUsd,
  planDirection,
  planLadder,
  planTitle,
  usageLines,
} from "../../account/billingModel";
import {
  AI_HOURS_TIME_NOTE,
  aiHoursHeadline,
  aiHoursSummary,
  aiHoursTodayLine,
  planAiHoursLine,
  planHasUnoAi,
} from "../../account/aiHours";
import { cn } from "../../lib/utils";
import { openInNewTab } from "../../navigation/useOpenApp";
import { formatElapsedAgoLabel } from "../../timestampFormat";
import { Meter, SectionCard } from "../computer/computerUi";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { paymentsQuery } from "./myUnoQueries";

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function CurrentPlanCard({
  subscription,
  catalog,
  cloud,
  sites,
  computers,
  balance,
  onSeePlans,
}: {
  subscription: AccountSubscription | null;
  catalog: PlanCatalog | undefined;
  cloud: CloudUsage | undefined;
  sites: SitesState | undefined;
  computers: number;
  balance: AccountBalance | undefined;
  onSeePlans: () => void;
}) {
  if (!subscription) {
    return (
      <SectionCard title="Your plan" icon={<CreditCardIcon />}>
        <p className="text-sm">No plan yet — you're on Free.</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Free has Uno Work on your own computer, sites on Uno Hosting and a little cloud. A plan
          adds computers in the cloud that are always a click away.
        </p>
        <div>
          <Button size="sm" onClick={onSeePlans}>
            <SparklesIcon />
            See plans
          </Button>
        </div>
      </SectionCard>
    );
  }
  const plan = subscription.limits ?? findPlan(catalog, subscription.plan);
  const pending = findPlan(catalog, subscription.pendingPlan);
  const renews = formatDate(subscription.nextBillingAt);
  const trialEnds = formatDate(subscription.trialExpiresAt);
  const lines = usageLines({
    subscription,
    cloudUsedBytes: cloud?.usedBytes ?? null,
    cloudQuotaBytes: cloud?.quotaBytes ?? null,
    sitesUsedBytes: sites?.usedBytes ?? null,
    sitesLimitBytes: sites?.limitBytes ?? null,
    computers,
  });
  const short = balance ? Math.max(0, subscription.priceUsd - balance.balanceUsd) : 0;

  return (
    <SectionCard
      title="Your plan"
      icon={<CreditCardIcon />}
      action={
        <Button size="xs" variant="ghost" onClick={onSeePlans}>
          Change plan
        </Button>
      }
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-2xl font-semibold tracking-tight" data-testid="my-uno-plan-name">
          {planTitle(plan, subscription.plan)}
        </span>
        <span className="text-sm text-muted-foreground">
          {subscription.priceUsd > 0 ? `${formatUsd(subscription.priceUsd)} a month` : "Free"}
        </span>
        {subscription.status !== "active" ? (
          <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning-foreground">
            {subscription.status}
          </span>
        ) : null}
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
        {trialEnds
          ? `Free course until ${trialEnds}.`
          : renews
            ? `Renews on ${renews} from your balance${short > 0 ? ` — add ${formatUsd(short)} before then` : ""}.`
            : null}
        {pending ? ` Switches to ${planTitle(pending)} then.` : ""}
      </p>

      {plan ? (
        <ul className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <li className="rounded-xl bg-muted/40 px-3 py-2">
            <div className="text-muted-foreground">Computer</div>
            <div className="font-medium">{computerSize(plan.peakRamMb, plan.peakVcpu)}</div>
          </li>
          <li className="rounded-xl bg-muted/40 px-3 py-2">
            <div className="text-muted-foreground">Working disk</div>
            <div className="font-medium">{subscription.diskGbOverride ?? plan.diskGb} GB</div>
          </li>
          <li className="rounded-xl bg-muted/40 px-3 py-2">
            <div className="text-muted-foreground">Cloud</div>
            <div className="font-medium">{plan.cloudGb > 0 ? `${plan.cloudGb} GB` : "—"}</div>
          </li>
          <li className="rounded-xl bg-muted/40 px-3 py-2">
            <div className="text-muted-foreground">Uno AI</div>
            <div className="font-medium">
              {planAiHoursLine(plan) ??
                (plan.aiCreditsUsd > 0
                  ? `${formatUsd(plan.aiCreditsUsd)} a month`
                  : "Bring your own")}
            </div>
          </li>
        </ul>
      ) : null}

      <ul className="flex flex-col gap-3" data-testid="my-uno-usage">
        {lines.map((line) => (
          <li key={line.key} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-medium">{line.label}</span>
              <span className="ml-auto tabular-nums text-muted-foreground">{line.value}</span>
            </div>
            {line.pct !== null ? <Meter value={line.pct} /> : null}
            {line.hint ? (
              <span className="text-[11px] text-muted-foreground">{line.hint}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

function MoneyCard({
  balance,
  subscription,
  usedTodayMinutes,
}: {
  balance: AccountBalance | undefined;
  subscription: AccountSubscription | null;
  usedTodayMinutes?: number | null | undefined;
}) {
  const ai = subscription?.aiCredits;
  const hours = aiHoursSummary({ subscription, balance, usedTodayMinutes });
  const today = hours ? aiHoursTodayLine(hours) : null;
  return (
    <SectionCard title="Balance and Uno AI" icon={<WalletIcon />}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1 rounded-xl bg-muted/40 px-3.5 py-3">
          <span className="text-xs text-muted-foreground">Balance</span>
          <span className="text-2xl font-semibold tabular-nums" data-testid="my-uno-balance">
            {balance ? formatUsd(balance.balanceUsd) : "…"}
          </span>
          <span className="text-[11px] text-muted-foreground">Pays for the plan each month.</span>
          <div className="mt-1">
            <Button size="sm" onClick={() => openInNewTab(consoleLinks.addMoney)}>
              Add money
              <ExternalLinkIcon />
            </Button>
          </div>
        </div>
        {hours ? (
          <div
            className="flex flex-col gap-1 rounded-xl bg-muted/40 px-3.5 py-3"
            data-testid="my-uno-ai-hours"
          >
            <span className="text-xs text-muted-foreground">
              {hours.unlimited ? "Uno AI" : "AI hours · never expire"}
            </span>
            <span className="text-2xl font-semibold tabular-nums">{aiHoursHeadline(hours)}</span>
            <span className="text-[11px] text-muted-foreground">
              {[
                today,
                hours.unlimited
                  ? "Full speed for the month's hours, then standard speed."
                  : hours.monthlyHours > 0
                    ? `Your plan adds ${hours.monthlyHours} h every month; unused hours roll over.`
                    : "Unused hours roll over.",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="text-[11px] text-muted-foreground">{AI_HOURS_TIME_NOTE}</span>
            <span className="text-[11px] text-muted-foreground">
              Premium models ((Grok, GLM-5.3, Kimi K3)):{" "}
              <span className="font-medium text-foreground tabular-nums">
                {formatUsd(hours.premiumUsd)}
              </span>{" "}
              premium credit, per token.
            </span>
          </div>
        ) : (
          <div className="flex flex-col gap-1 rounded-xl bg-muted/40 px-3.5 py-3">
            <span className="text-xs text-muted-foreground">Uno AI credits</span>
            <span className="text-2xl font-semibold tabular-nums" data-testid="my-uno-ai-balance">
              {balance ? formatUsd(balance.aiBalanceUsd) : "…"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {ai && ai.monthlyUsd > 0
                ? `Your plan adds ${formatUsd(ai.monthlyUsd)} every month${ai.carryUsd > 0 ? `; ${formatUsd(ai.carryUsd)} carried over from last month` : ""}.`
                : "Chats, dictation, the notetaker and apps that use AI spend these."}
            </span>
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Adding money and switching plans happen in the Uno console in your browser — you're already
        signed in there. Everything else you see here.
      </p>
    </SectionCard>
  );
}

function PlanCard({
  rung,
  withAi,
  subscription,
}: {
  rung: PlanRung;
  withAi: boolean;
  subscription: AccountSubscription | null;
}) {
  const plan: AccountPlan | null = (withAi ? rung.withAi : rung.plain) ?? rung.plain ?? rung.withAi;
  if (!plan) return null;
  const direction = planDirection(subscription, plan);
  const current = direction === "current";
  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl border p-4",
        current ? "border-primary bg-primary/5" : "border-border/60 bg-card/40",
      )}
      data-testid="my-uno-plan-card"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold">{planTitle(plan)}</span>
        {current ? (
          <span className="ml-auto flex items-center gap-1 text-[11px] font-medium text-primary">
            <CheckIcon className="size-3" /> Your plan
          </span>
        ) : null}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tabular-nums">{formatUsd(plan.priceUsd)}</span>
        <span className="text-xs text-muted-foreground">/ month</span>
      </div>
      <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">
            {computerSize(plan.peakRamMb, plan.peakVcpu)}
          </span>{" "}
          {plan.cloudWork ? "· Uno Work in the cloud" : "· a small server"}
        </li>
        <li>{plan.diskGb} GB working disk</li>
        {plan.cloudGb > 0 ? <li>{plan.cloudGb} GB cloud</li> : null}
        {plan.boostHours > 0 ? <li>{plan.boostHours} boost hours a month</li> : null}
        {planHasUnoAi(plan) && planAiHoursLine(plan) !== null ? (
          <>
            <li className="text-foreground">
              <SparklesIcon className="mr-1 inline size-3 text-primary" />
              {planAiHoursLine(plan)}
            </li>
            {(plan.aiPremiumUsd ?? plan.aiCreditsUsd) > 0 ? (
              <li>{formatUsd(plan.aiPremiumUsd ?? plan.aiCreditsUsd)} premium credit a month</li>
            ) : null}
          </>
        ) : plan.aiCreditsUsd > 0 ? (
          <li className="text-foreground">
            <SparklesIcon className="mr-1 inline size-3 text-primary" />
            {formatUsd(plan.aiCreditsUsd)} of Uno AI a month
          </li>
        ) : null}
      </ul>
      <div className="mt-auto">
        {current ? (
          <Button size="sm" variant="outline" disabled className="w-full">
            Current plan
          </Button>
        ) : (
          <Button
            size="sm"
            variant={direction === "upgrade" || direction === "start" ? "default" : "outline"}
            className="w-full"
            onClick={() => openInNewTab(consoleLinks.plan(plan.slug))}
          >
            {direction === "start" ? "Choose" : direction === "upgrade" ? "Upgrade" : "Switch"}
            <ExternalLinkIcon />
          </Button>
        )}
      </div>
    </li>
  );
}

function PlansCard({
  catalog,
  loading,
  subscription,
}: {
  catalog: PlanCatalog | undefined;
  loading: boolean;
  subscription: AccountSubscription | null;
}) {
  const rungs = useMemo(() => (catalog ? planLadder(catalog) : []), [catalog]);
  const hasAiOption = rungs.some((rung) => rung.withAi !== null && rung.plain !== null);
  const currentHasAi = subscription?.limits ? planHasUnoAi(subscription.limits) : false;
  const hoursCatalog = rungs.some((rung) => rung.withAi?.aiHoursMonthly != null);
  const [withAi, setWithAi] = useState(currentHasAi);

  return (
    <SectionCard
      title="Plans"
      icon={<SparklesIcon />}
      action={
        hasAiOption ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch checked={withAi} onCheckedChange={setWithAi} aria-label="With Uno AI" />
            With Uno AI
          </label>
        ) : null
      }
    >
      <p className="-mt-2 text-xs text-muted-foreground">
        A plan is your computer in the cloud: split it into a workspace and a couple of servers if
        you like.
        {hasAiOption
          ? hoursCatalog
            ? " With Uno AI, the plan adds AI hours every month, unlimited inside them — or bring your own Claude or ChatGPT subscription."
            : " With Uno AI, the plan also tops up AI credits every month — or bring your own Claude or ChatGPT subscription."
          : ""}
      </p>
      {loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-56 rounded-2xl" />
          ))}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" id="my-uno-plans">
          {rungs.map((rung) => (
            <PlanCard key={rung.key} rung={rung} withAi={withAi} subscription={subscription} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function HistoryCard() {
  const payments = useQuery(paymentsQuery(true));
  const rows = payments.data ?? [];
  return (
    <SectionCard title="History" icon={<ArrowDownLeftIcon />}>
      {payments.isPending ? (
        <Skeleton className="h-28 rounded-xl" />
      ) : payments.isError ? (
        <p className="text-xs text-muted-foreground">
          Couldn't read the history just now.{" "}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => openInNewTab(consoleLinks.addMoney)}
          >
            See it in the console
          </button>
          .
        </p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No payments yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60" data-testid="my-uno-history">
          {rows.slice(0, 30).map((row) => (
            <li key={row.key} className="flex items-center gap-3 py-2 text-xs">
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-lg [&_svg]:size-3.5",
                  row.direction === "in"
                    ? "bg-success/10 text-success-foreground"
                    : "bg-muted text-muted-foreground",
                )}
              >
                {row.direction === "in" ? <ArrowDownLeftIcon /> : <ArrowUpRightIcon />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{row.title}</span>
                <span className="block text-muted-foreground">
                  {formatElapsedAgoLabel(row.at)}
                  {row.status && row.status !== "completed" ? ` · ${row.status}` : ""}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 tabular-nums font-medium",
                  row.direction === "in" ? "text-success-foreground" : "text-foreground",
                )}
              >
                {row.direction === "in" ? "+" : "−"}
                {formatUsd(row.amountUsd)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function scrollToPlans() {
  document.getElementById("my-uno-plans")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function BillingView(props: {
  subscription: AccountSubscription | null;
  subscriptionLoading: boolean;
  catalog: PlanCatalog | undefined;
  catalogLoading: boolean;
  balance: AccountBalance | undefined;
  cloud: CloudUsage | undefined;
  sites: SitesState | undefined;
  computers: number;
  /** Today's AI hours use from `/v1/ai/status`, when the machine has read it. */
  aiUsedTodayMinutes?: number | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      {props.subscriptionLoading ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : (
        <CurrentPlanCard
          subscription={props.subscription}
          catalog={props.catalog}
          cloud={props.cloud}
          sites={props.sites}
          computers={props.computers}
          balance={props.balance}
          onSeePlans={scrollToPlans}
        />
      )}
      <MoneyCard
        balance={props.balance}
        subscription={props.subscription}
        usedTodayMinutes={props.aiUsedTodayMinutes}
      />
      <PlansCard
        catalog={props.catalog}
        loading={props.catalogLoading}
        subscription={props.subscription}
      />
      <HistoryCard />
    </div>
  );
}
