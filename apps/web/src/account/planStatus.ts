/**
 * The one line under the plan's name in My Uno → Plan & billing, from the same
 * `/box-subscription` fields the console reads (flows v2, A12): a cancelled
 * plan says when it ends and that nothing more is charged — never "Renews".
 */
import { CONSOLE_URL, type AccountSubscription } from "./accountOverview";

/** "Keep my plan" lives in the console (it shows what stays and what is charged). */
export const KEEP_PLAN_URL = `${CONSOLE_URL}/billing?resume=1`;
export const CHOOSE_PLAN_URL = `${CONSOLE_URL}/billing?tab=plan`;

export type PlanStatusLine =
  | { readonly kind: "trial" | "renews"; readonly text: string }
  | {
      readonly kind: "cancelled";
      readonly text: string;
      readonly action: { readonly label: "Keep my plan"; readonly href: string };
    }
  | {
      readonly kind: "ended";
      readonly text: string;
      readonly action: { readonly label: "Choose a plan"; readonly href: string };
    };

export function planStatusLine(input: {
  readonly subscription: Pick<
    AccountSubscription,
    "status" | "nextBillingAt" | "trialExpiresAt" | "cancelledAt" | "planEndedAt" | "keepUntil"
  >;
  /** How much the balance is short of the next charge, in dollars. */
  readonly shortUsd: number;
  readonly pendingPlanTitle: string | null;
  readonly formatDate: (iso: string | null) => string | null;
  readonly formatUsd: (usd: number) => string;
}): PlanStatusLine | null {
  const { subscription: sub, formatDate } = input;
  const ended = formatDate(sub.planEndedAt);
  if (ended) {
    const keep = formatDate(sub.keepUntil);
    return {
      kind: "ended",
      text: keep
        ? `Ended on ${ended}. Your computers are kept until ${keep}.`
        : `Ended on ${ended}.`,
      action: { label: "Choose a plan", href: CHOOSE_PLAN_URL },
    };
  }
  const next = formatDate(sub.nextBillingAt);
  if (sub.cancelledAt && sub.status === "active") {
    return {
      kind: "cancelled",
      text: next ? `Ends on ${next}, no more charges.` : "Cancelled, no more charges.",
      action: { label: "Keep my plan", href: KEEP_PLAN_URL },
    };
  }
  const trial = formatDate(sub.trialExpiresAt);
  if (trial) return { kind: "trial", text: `Free course until ${trial}.` };
  if (!next) return null;
  const add = input.shortUsd > 0 ? ` — add ${input.formatUsd(input.shortUsd)} before then` : "";
  const switches = input.pendingPlanTitle ? ` Switches to ${input.pendingPlanTitle} then.` : "";
  return { kind: "renews", text: `Renews on ${next} from your balance${add}.${switches}` };
}
