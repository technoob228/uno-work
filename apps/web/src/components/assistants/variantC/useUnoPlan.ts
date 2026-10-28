/**
 * Variant C: Uno lives on the cloud computer. On Plus it never sleeps — the
 * morning summary comes at 08:00 and Telegram is answered right away; on Free
 * it sleeps when the person leaves, so Uno catches up when Work opens. The
 * honest line about that reads the plan from the account (`/box-subscription`).
 */
import { useQuery } from "@tanstack/react-query";

import { CHOOSE_PLAN_URL } from "../../../account/planStatus";
import { subscriptionQuery } from "../../myuno/myUnoQueries";

/** "free" | "plus" | …; null while unknown (no account here, still loading). */
export function useUnoPlan(): string | null {
  const subscription = useQuery(subscriptionQuery()).data;
  return subscription ? subscription.plan.toLowerCase() : null;
}

export const PLUS_URL = CHOOSE_PLAN_URL;
