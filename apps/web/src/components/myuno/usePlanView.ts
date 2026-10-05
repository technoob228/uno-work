/**
 * How this account's plan reads, for screens outside My Uno (the computer
 * menu, Boost, economy): "boosts" on plans "always on", "hours" otherwise —
 * also while the subscription isn't read yet or the account isn't reachable
 * from this window (a computer's own address), so nothing changes there.
 */
import { useQuery } from "@tanstack/react-query";

import { showsAlwaysOn } from "../../account/alwaysOn";
import type { BoostWording } from "../computer/boostModel";
import { accountReachable, subscriptionQuery } from "./myUnoQueries";

export function useBoostWording(): BoostWording {
  const reachable = accountReachable();
  const subscription = useQuery({ ...subscriptionQuery(), enabled: reachable }).data ?? null;
  return showsAlwaysOn(subscription) ? "boosts" : "hours";
}
