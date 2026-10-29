/**
 * Uno AI premium credit (Claude / GPT / Gemini on the plan's monthly premium
 * credit). The gateway reports it in `/v1/ai/status` → `premium`; when the
 * credit is used up and "continue from balance" is off it answers premium
 * requests with Smart (`exhausted: true`). Then one calm line in the
 * composer says so, with the way to keep the premium model: continue from
 * the balance on the console's billing page.
 *
 * OpenCode on Uno AI too (agent-flow pass 25.10, item 5): "Claude Sonnet 5.5
 * · Uno AI" picked in the OpenCode tab with $0 premium was answered by Smart
 * and the chat said nothing — the line only knew Uno Code and Hermes. (The
 * Claude tab on Uno AI gets the same words from the gateway itself, as the
 * first text of the answer.) With no money to continue from, the way on is
 * "Add credit"; a trial has no monthly credit, so it promises none.
 *
 * Pure helpers are unit-tested in aiHoursUi.test.ts.
 */
import type {
  EnvironmentId,
  ModelCapabilities,
  ProviderDriverKind,
  UnoAiPremiumStatus,
  UnoAiStatus,
} from "@t3tools/contracts";
import {
  UNO_FAST_GATEWAY_MODEL,
  UNO_GLM_FLASH_GATEWAY_MODEL,
  UNO_SMART_GATEWAY_MODEL,
} from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { memo } from "react";

import { CONSOLE_URL } from "../../account/accountOverview";
import { AI_STATUS_PREMIUM_POLL_MS, useAiStatus } from "../../lib/aiStatusReactQuery";
import { openInNewTab } from "../../navigation/useOpenApp";
import { unoGatewayModelId } from "./unoModelIds";

/** "Continue from balance" and the premium credit: the console billing page's premium card. */
export const UNO_PREMIUM_BILLING_URL = `${CONSOLE_URL}/billing#premium`;
export const UNO_PREMIUM_CONTINUE_LABEL = "Continue from balance";
export const UNO_PREMIUM_ADD_CREDIT_LABEL = "Add credit";

/** OpenCode's provider id for the Uno AI gateway (server UnoDriver `UNO_PROVIDER_ID`). */
const OPENCODE_UNO_PROVIDER_PREFIX = "uno/";

const INCLUDED_GATEWAY_IDS: ReadonlySet<string> = new Set([
  UNO_SMART_GATEWAY_MODEL,
  UNO_FAST_GATEWAY_MODEL,
  // The assistant's default (29.10): in AI hours though `/v1/models` doesn't list it.
  UNO_GLM_FLASH_GATEWAY_MODEL,
]);

/**
 * A premium model of the Uno gateway is picked (Uno Code, Hermes, or OpenCode
 * on its `uno` provider): marked `premium` by the gateway, or — without a mark
 * — anything but Smart / Fast / GLM-5.3 Flash and the private GPU.
 */
export function isUnoPremiumModelSelected(input: {
  readonly driverKind: ProviderDriverKind | string | null | undefined;
  readonly slug: string | null | undefined;
  readonly capabilities?: ModelCapabilities | null | undefined;
}): boolean {
  const slug = input.slug?.trim();
  if (!slug) return false;
  if (input.driverKind === "opencode") {
    // OpenCode lists the gateway as its provider `uno` (`uno/anthropic/…`,
    // `uno/uno/smart`); its own models (`opencode/…`) are not Uno AI.
    if (!slug.toLowerCase().startsWith(OPENCODE_UNO_PROVIDER_PREFIX)) return false;
    const gatewayId = unoGatewayModelId(slug);
    return !INCLUDED_GATEWAY_IDS.has(gatewayId) && !gatewayId.startsWith("uno-personal/");
  }
  if (input.driverKind !== "uno" && input.driverKind !== "hermes") return false;
  const group = input.capabilities?.metadata?.unoGroup;
  if (group !== undefined) return group === "premium";
  if (slug.startsWith("uno-personal/")) return false;
  // Hermes lists gateway ids (`uno/smart`), Uno Code prefixes them (`uno/uno/smart`).
  return (
    !INCLUDED_GATEWAY_IDS.has(slug.toLowerCase()) &&
    !INCLUDED_GATEWAY_IDS.has(unoGatewayModelId(slug))
  );
}

/** "$23.40", "$30". */
function formatCredit(usd: number): string {
  const rounded = Math.round(Math.max(0, usd) * 100) / 100;
  return Number.isInteger(rounded) ? `$${rounded}` : `$${rounded.toFixed(2)}`;
}

/** "2026-10-24T02:39:00Z" → "Oct 24"; null when there is no usable date. */
function formatRenewDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(at);
}

/**
 * Heading of the picker's Premium group with the credit left:
 * "Premium · $23.40 of $30 left". Null when no premium limit applies (the
 * picker keeps its usual heading then).
 */
export function premiumCreditHeading(
  premium: UnoAiPremiumStatus | null | undefined,
): string | null {
  if (!premium?.limited || premium.leftUsd === null) return null;
  const total = premium.monthlyUsd ?? premium.limitUsd;
  const left = formatCredit(premium.leftUsd);
  return total !== null && total > 0
    ? `Premium · ${left} of ${formatCredit(total)} left`
    : `Premium · ${left} left`;
}

export interface PremiumFallbackNotice {
  readonly text: string;
  readonly actionLabel: string;
  readonly actionUrl: string;
}

/**
 * The line shown while a premium model is picked and its answers come from
 * Smart; null otherwise (the usual case).
 */
export function premiumFallbackNotice(
  status: Pick<UnoAiStatus, "premium" | "renewsAt" | "smartPaused"> | null | undefined,
  premiumSelected: boolean,
): PremiumFallbackNotice | null {
  const premium = status?.premium;
  if (!premiumSelected || !premium?.exhausted) return null;
  // No AI time either and Smart is paused (smart stop): the gateway answers
  // premium with Fast, and the "Smart is paused… Add AI time" strip says so.
  if (status?.smartPaused === true) return null;
  // A plan without monthly premium credit (the trial) gets none next month either.
  const monthlyCredit = premium.monthlyUsd === null || premium.monthlyUsd > 0;
  const date = formatRenewDate(premium.renewsAt ?? status?.renewsAt);
  const renew = !monthlyCredit
    ? ""
    : date
      ? ` New credit on ${date}.`
      : " New credit arrives when your plan renews.";
  // Money to continue from (top-ups, the main balance): turning on "Continue
  // from balance" is enough. Without it the way on is adding credit.
  const hasMoney = (premium.balanceUsd ?? 0) >= 0.01;
  return {
    text: `Answered by Smart: no Premium credit.${renew}`,
    actionLabel: hasMoney ? UNO_PREMIUM_CONTINUE_LABEL : UNO_PREMIUM_ADD_CREDIT_LABEL,
    actionUrl: UNO_PREMIUM_BILLING_URL,
  };
}

export const PremiumCreditNotice = memo(function PremiumCreditNotice(props: {
  environmentId: EnvironmentId | null;
  /** A premium model of the Uno gateway is picked: only then is the status read. */
  premiumSelected: boolean;
}) {
  const status = useAiStatus(props.environmentId, {
    enabled: props.premiumSelected,
    pollMs: AI_STATUS_PREMIUM_POLL_MS,
  });
  const notice = premiumFallbackNotice(status, props.premiumSelected);
  if (!notice) return null;
  // A calm strip, not a whisper: the person picked a model and another one
  // answers, so it has to be seen (the old one-line caption went unnoticed).
  return (
    <div
      className="mx-3 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/70 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
      role="status"
      data-testid="premium-fallback-notice"
    >
      <SparklesIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 text-foreground/80">{notice.text}</span>
      <button
        type="button"
        className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline"
        onClick={() => openInNewTab(notice.actionUrl)}
      >
        {notice.actionLabel}
      </button>
    </div>
  );
});
