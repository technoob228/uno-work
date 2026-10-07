/**
 * Uno AI after the AI time is used up on a plan with unlimited Fast (fishcode
 * AI_SMART_STOP, Misha 07.10): Smart is paused — its requests are answered by
 * Fast, nothing is charged per use — and the way on is the AI time pack. The
 * gateway reports it in `/v1/ai/status` → `smart_paused` / `ai_pack`; every
 * Smart answer also carries `x_uno.smart_paused`. Here: one clear strip above
 * the composer with the pack button, which opens the console's pack checkout
 * in a new tab (Misha's rule: console ↔ Work in a new tab).
 *
 * Pure helpers are unit-tested in aiHoursUi.test.ts.
 */
import type { EnvironmentId, UnoAiStatus } from "@t3tools/contracts";
import { SparklesIcon } from "lucide-react";
import { memo } from "react";

import { CONSOLE_URL } from "../../account/accountOverview";
import { AI_SMART_PAUSED_LINE } from "../../account/aiHours";
import { AI_STATUS_PREMIUM_POLL_MS, useAiStatus } from "../../lib/aiStatusReactQuery";
import { openInNewTab } from "../../navigation/useOpenApp";
import { Button } from "../ui/button";

/** The console's AI time pack checkout ("+15 AI hours · $10 · Pay"). */
export const UNO_AI_PACK_URL = `${CONSOLE_URL}/billing?ai_pack=1`;

/** "Add AI time — +15 h for $10"; "Add AI time" without a usable size. */
export function addAiTimeLabel(pack: UnoAiStatus["aiPack"]): string {
  if (!pack || !(pack.hours > 0) || !(pack.priceUsd > 0)) return "Add AI time";
  const price = Number.isInteger(pack.priceUsd)
    ? `$${pack.priceUsd}`
    : `$${pack.priceUsd.toFixed(2)}`;
  return `Add AI time — +${pack.hours} h for ${price}`;
}

export interface SmartPausedNoticeModel {
  readonly text: string;
  readonly actionLabel: string;
  readonly actionUrl: string;
}

/** The strip while a chat on Uno AI is open and Smart is paused; null otherwise. */
export function smartPausedNotice(
  status: Pick<UnoAiStatus, "smartPaused" | "aiPack"> | null | undefined,
  unoSelected: boolean,
): SmartPausedNoticeModel | null {
  if (!unoSelected || status?.smartPaused !== true) return null;
  return {
    text: AI_SMART_PAUSED_LINE,
    actionLabel: addAiTimeLabel(status.aiPack),
    actionUrl: UNO_AI_PACK_URL,
  };
}

export const SmartPausedNotice = memo(function SmartPausedNotice(props: {
  environmentId: EnvironmentId | null;
  /** The chat runs on Uno AI (Uno Code or Hermes on the gateway): only then is the status read. */
  unoSelected: boolean;
}) {
  const status = useAiStatus(props.environmentId, {
    enabled: props.unoSelected,
    pollMs: AI_STATUS_PREMIUM_POLL_MS,
  });
  const notice = smartPausedNotice(status, props.unoSelected);
  if (!notice) return null;
  return (
    <div
      className="mx-3 mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm"
      role="status"
      data-testid="smart-paused-notice"
    >
      <SparklesIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">{notice.text}</span>
      <Button size="sm" type="button" onClick={() => openInNewTab(notice.actionUrl)}>
        {notice.actionLabel}
      </Button>
    </div>
  );
});
