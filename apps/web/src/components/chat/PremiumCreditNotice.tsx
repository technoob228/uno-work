/**
 * Uno AI premium credit (Claude / GPT / Gemini on the plan's monthly premium
 * credit). The gateway reports it in `/v1/ai/status` → `premium`; when the
 * credit is used up and "continue from balance" is off it answers premium
 * requests with Smart (`exhausted: true`). Then one calm line in the
 * composer says so, with the way to keep the premium model: continue from
 * the balance on the console's billing page.
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
import { UNO_FAST_GATEWAY_MODEL, UNO_SMART_GATEWAY_MODEL } from "@t3tools/contracts";
import { memo } from "react";

import { CONSOLE_URL } from "../../account/accountOverview";
import { AI_STATUS_PREMIUM_POLL_MS, useAiStatus } from "../../lib/aiStatusReactQuery";
import { openInNewTab } from "../../navigation/useOpenApp";
import { unoGatewayModelId } from "./unoModelIds";

/** "Continue from balance" and the premium credit live on the console's billing page. */
export const UNO_PREMIUM_BILLING_URL = `${CONSOLE_URL}/billing`;
export const UNO_PREMIUM_CONTINUE_LABEL = "Continue from balance";

const INCLUDED_GATEWAY_IDS: ReadonlySet<string> = new Set([
  UNO_SMART_GATEWAY_MODEL,
  UNO_FAST_GATEWAY_MODEL,
]);

/**
 * A premium model of the Uno gateway is picked (Uno Code or Hermes): marked
 * `premium` by the gateway, or — without a mark — anything but Smart / Fast
 * and the private GPU.
 */
export function isUnoPremiumModelSelected(input: {
  readonly driverKind: ProviderDriverKind | string | null | undefined;
  readonly slug: string | null | undefined;
  readonly capabilities?: ModelCapabilities | null | undefined;
}): boolean {
  if (input.driverKind !== "uno" && input.driverKind !== "hermes") return false;
  const slug = input.slug?.trim();
  if (!slug) return false;
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
  status: Pick<UnoAiStatus, "premium" | "renewsAt"> | null | undefined,
  premiumSelected: boolean,
): PremiumFallbackNotice | null {
  const premium = status?.premium;
  if (!premiumSelected || !premium?.exhausted) return null;
  const date = formatRenewDate(premium.renewsAt ?? status?.renewsAt);
  const renew = date ? `New credit on ${date}.` : "New credit arrives when your plan renews.";
  return {
    text: `Premium credit used up — answering with Smart. ${renew}`,
    actionLabel: UNO_PREMIUM_CONTINUE_LABEL,
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
  return (
    <p
      className="flex flex-wrap items-center gap-x-1.5 px-3 pt-2 text-xs text-muted-foreground"
      role="status"
      data-testid="premium-fallback-notice"
    >
      <span>{notice.text}</span>
      <button
        type="button"
        className="font-medium text-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => openInNewTab(notice.actionUrl)}
      >
        {notice.actionLabel}
      </button>
    </p>
  );
});
