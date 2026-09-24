/**
 * The top of My Uno in web lite: where the person stands on the ladder and
 * the next step. Free and Small get "Uno Work in the cloud starts at Plus"
 * plus what's free right now; a plan that already includes it gets one button
 * that opens it (the backend sets the computer up on that load).
 */
import { BotIcon, DownloadIcon, GlobeIcon, SparklesIcon } from "lucide-react";

import type { AccountSubscription, PlanCatalog } from "../account/accountOverview";
import { planTitle } from "../account/billingModel";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import {
  cheapestCloudPlan,
  liteLadder,
  liteLinks,
  liteStanding,
  openCloudWork,
  type LiteStanding,
} from "./webLite";

function headline(
  standing: LiteStanding,
  plan: string,
  from: string,
): { title: string; body: string } {
  switch (standing) {
    case "free":
      return {
        title: "You're on Free: websites, your own AI and this app are free.",
        body: `Uno Work in the cloud — chats, agents and files on a computer that's always on — starts at Plus${from}.`,
      };
    case "small":
      return {
        title: `Your ${plan} is a server.`,
        body: `It keeps your apps and sites running around the clock. Uno Work in the cloud starts at Plus${from}.`,
      };
    case "other":
      return {
        title: `${plan} doesn't include Uno Work in the cloud.`,
        body: `It starts at Plus${from}. Your computers, sites and files stay as they are.`,
      };
    case "cloud":
      return {
        title: `${plan} includes Uno Work in the cloud.`,
        body: "Open it and Uno sets up your computer. Just upgraded? Give it up to 30 seconds to catch up.",
      };
  }
}

function External({
  href,
  icon,
  children,
  testId,
}: {
  href: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <Button
      size="sm"
      variant="outline"
      render={<a href={href} target="_blank" rel="noreferrer" data-testid={testId} />}
    >
      {icon}
      {children}
    </Button>
  );
}

export function LiteBanner({
  subscription,
  loading,
  catalog,
}: {
  subscription: AccountSubscription | null;
  loading: boolean;
  catalog: PlanCatalog | undefined;
}) {
  if (loading) {
    return <Skeleton className="h-40 w-full rounded-2xl" />;
  }
  const standing = liteStanding(subscription);
  const plus = cheapestCloudPlan(catalog);
  const from = plus ? ` ($${plus.priceUsd}/mo)` : "";
  const plan = subscription ? planTitle(subscription.limits, subscription.plan) : "Free";
  const { title, body } = headline(standing, plan, from);
  const rungs = liteLadder(catalog, standing);

  return (
    <section
      className="flex flex-col gap-4 rounded-2xl border border-border/60 bg-card/40 p-4 sm:p-5"
      data-testid="lite-banner"
      data-standing={standing}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-base font-semibold text-balance">{title}</h1>
        <p className="text-sm text-pretty text-muted-foreground">{body}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {standing === "cloud" ? (
          <Button size="sm" onClick={openCloudWork} data-testid="lite-open-cloud-banner">
            <SparklesIcon />
            Open Uno Work in the cloud
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              render={<a href={liteLinks.plus} target="_blank" rel="noreferrer" />}
              data-testid="lite-get-plus"
            >
              <SparklesIcon />
              Get Uno Work in the cloud — from Plus
            </Button>
            <External href={liteLinks.download} icon={<DownloadIcon />} testId="lite-download">
              Download for Mac/Windows
            </External>
            <External href={liteLinks.connectAi} icon={<BotIcon />} testId="lite-connect-ai">
              Connect your own AI
            </External>
            <External href={liteLinks.publishSite} icon={<GlobeIcon />} testId="lite-publish">
              Publish a website for free
            </External>
          </>
        )}
      </div>

      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-3" aria-label="Plans">
        {rungs.map((rung) => (
          <li
            key={rung.key}
            className={cn(
              "flex flex-col gap-0.5 rounded-xl border px-3 py-2",
              rung.current ? "border-primary/60 bg-primary/5" : "border-border/50",
            )}
            aria-current={rung.current ? "step" : undefined}
          >
            <span className="flex items-center gap-1.5 text-xs font-medium">
              {rung.title}
              {rung.current ? (
                <span className="rounded-full bg-primary/10 px-1.5 py-px text-[10px] text-primary">
                  you
                </span>
              ) : null}
            </span>
            <span className="text-xs text-muted-foreground">{rung.what}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
