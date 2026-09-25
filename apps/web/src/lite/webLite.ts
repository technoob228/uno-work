/**
 * "Web lite" — Uno Work in the browser for people without Uno Work in the
 * cloud (Free and Small plans). app.uno4.work serves this build to a
 * signed-in person who has no Uno Work computer and no plan that could run
 * one (fishcode: BOX_WORK_LITE_DIR). It is My Uno only — computers, sites,
 * cloud storage, plan & billing — read from the account API; no chats, no
 * agent, no terminal, no machine connection.
 *
 * Chosen at build time (`bun run build:lite` → dist-lite), never guessed at
 * runtime: the same bundle can't accidentally turn into the full app or back.
 *
 * Everything here is free of React so the ladder and the gating are unit
 * tested.
 */
import type { AccountPlan, AccountSubscription, PlanCatalog } from "../account/accountOverview";
import { CONSOLE_URL } from "../account/accountOverview";
import { planHasUnoAi } from "../account/aiHours";

/** True in the lite build only (VITE_UNO_WORK_LITE=1 / `vite build --mode lite`). */
export { isWebLite } from "./flag";

/** Where lite lives. Every other path of the full app lands here. */
export const LITE_HOME_PATH = "/my-uno";

/**
 * The path lite should be on for a requested one, or null when it may stay.
 * Only My Uno exists in lite; chats, settings, pairing and onboarding need a
 * computer this page is not connected to.
 */
export function liteRedirectPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  return path === LITE_HOME_PATH ? null : LITE_HOME_PATH;
}

export const liteLinks = {
  /** Upgrade to Plus in the console (it opens the plan step with Plus picked). */
  plus: `${CONSOLE_URL}/billing?tab=plan&plan=plus`,
  download: "https://uno4.work/download/",
  connectAi: `${CONSOLE_URL}/start?path=agent`,
  publishSite: `${CONSOLE_URL}/sites`,
  /** app.uno4.work's own sign-out (clears the uno_work cookie). */
  logout: "/logout",
} as const;

/**
 * Where the person stands on the ladder:
 *   free  — no plan: websites, their own AI and the Uno Work app are free;
 *   small — a server (Small), still no Uno Work in the cloud;
 *   other — any other plan without Uno Work in the cloud (legacy mini/nano,
 *           the free course);
 *   cloud — the plan includes Uno Work in the cloud (Plus and up) but there's
 *           no machine yet: a full reload of "/" makes the backend create it.
 */
export type LiteStanding = "free" | "small" | "other" | "cloud";

function baseSlug(slug: string): string {
  return slug.replace(/-ai$/, "");
}

export function liteStanding(subscription: AccountSubscription | null): LiteStanding {
  if (!subscription) return "free";
  if (subscription.limits?.cloudWork === true) return "cloud";
  const slug = subscription.limits?.baseSlug || baseSlug(subscription.plan);
  if (slug === "free") return "free";
  if (slug === "small") return "small";
  return "other";
}

/** The cheapest plan that runs Uno Work in the cloud, without Uno AI. */
export function cheapestCloudPlan(catalog: PlanCatalog | undefined): AccountPlan | null {
  const candidates = (catalog?.plans ?? []).filter(
    (plan) => plan.cloudWork && !plan.legacy && !planHasUnoAi(plan),
  );
  return candidates.toSorted((a, b) => a.priceUsd - b.priceUsd)[0] ?? null;
}

/**
 * "Open Uno Work in the cloud": the backend decides what "/" serves. After
 * an upgrade it provisions the cloud computer on this load (its plan cache
 * can lag up to ~30 s — the button says so).
 */
export function openCloudWork(): void {
  window.location.assign("/");
}

export interface LiteRung {
  readonly key: "free" | "small" | "cloud";
  readonly title: string;
  readonly what: string;
  readonly current: boolean;
}

function cores(vcpu: number): string {
  return vcpu === 1 ? "1 core" : `${vcpu} cores`;
}

/**
 * The three steps of the ladder, as lite shows them: Free = websites + your AI
 * + the Uno Work app; Small = a server; Plus and up = Uno Work in the cloud.
 * Sizes come from the catalog when it has them.
 */
export function liteLadder(
  catalog: PlanCatalog | undefined,
  standing: LiteStanding | null,
): ReadonlyArray<LiteRung> {
  const plans = (catalog?.plans ?? []).filter((plan) => !plan.legacy && !planHasUnoAi(plan));
  const small = plans.find((plan) => plan.baseSlug === "small" || plan.slug === "small") ?? null;
  const cloud = plans.filter((plan) => plan.cloudWork).toSorted((a, b) => a.priceUsd - b.priceUsd);
  const cloudFrom = cloud[0] ?? null;
  const cloudTo = cloud.at(-1) ?? null;
  const cloudCores =
    cloudFrom && cloudTo && cloudTo.maxBoxVcpu > cloudFrom.maxBoxVcpu
      ? `${cloudFrom.maxBoxVcpu}–${cloudTo.maxBoxVcpu} cores`
      : cloudFrom
        ? cores(cloudFrom.maxBoxVcpu)
        : null;
  return [
    {
      key: "free",
      title: "Free",
      what: "Websites, your own AI, the Uno Work app",
      current: standing === "free",
    },
    {
      key: "small",
      title: small ? `${small.name} · $${small.priceUsd}/mo` : "Small",
      what: small && small.maxBoxVcpu > 0 ? `A server, ${cores(small.maxBoxVcpu)}` : "A server",
      current: standing === "small" || standing === "other",
    },
    {
      key: "cloud",
      title: cloudFrom
        ? `${cloudFrom.name} and up · from $${cloudFrom.priceUsd}/mo`
        : "Plus and up",
      what: cloudCores ? `Uno Work in the cloud, ${cloudCores}` : "Uno Work in the cloud",
      current: standing === "cloud",
    },
  ];
}

/**
 * My Uno's empty computer list in lite: Free and Small can't add an Uno Work
 * computer, so don't suggest one. Null = the usual copy (a plan with Uno Work
 * in the cloud, or not lite).
 */
export function liteEmptyComputersCopy(subscription: AccountSubscription | null): string | null {
  if (liteStanding(subscription) === "cloud") return null;
  return "No computers yet. A Small server runs your backend or bot; Uno Work in the cloud starts at Plus.";
}
