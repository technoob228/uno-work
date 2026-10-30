/**
 * Every computer of the person with its own AI plan numbers (Home's "AI plan
 * limits", `uno.computer.planLimits`), for the rules in `planRoom.logic.ts`.
 *
 * Only connected computers whose daemon reads limits (0.0.157+) are asked;
 * each answer is the daemon's 5-minute cache, shared with Home's widget
 * through the same query key — opening a new chat costs no extra call to
 * Anthropic or OpenAI. Mounted only where it is shown (a new chat, a chat
 * that stopped at its limit, Settings → AI), never in the background.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { planLimitsQueryOptions } from "../components/computer/home/useHomeInfo";
import { useSwitcherMachines } from "../components/computerSwitcher/useComputerSwitcher";
import { descriptorSupportsPlanLimits } from "../environments/planLimitsSupport";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import type { PlanComputer } from "./planRoom.logic";

export function usePlanComputers(options: { readonly enabled?: boolean } = {}): {
  readonly computers: ReadonlyArray<PlanComputer>;
  /** Some computer's numbers are still on their way. */
  readonly pending: boolean;
} {
  const enabled = options.enabled !== false;
  const machines = useSwitcherMachines();
  const primary = usePrimaryEnvironmentDescriptor();
  const supportedIds = useSavedEnvironmentRuntimeStore((state) =>
    Object.values(state.byId)
      .filter((runtime) => descriptorSupportsPlanLimits(runtime?.descriptor))
      .map((runtime) => runtime!.descriptor!.environmentId)
      .toSorted()
      .join("\n"),
  );
  const supports = useMemo(() => {
    const ids = new Set<string>(supportedIds ? supportedIds.split("\n") : []);
    if (primary && descriptorSupportsPlanLimits(primary)) ids.add(primary.environmentId);
    return ids;
  }, [primary, supportedIds]);

  const asked = machines.filter(
    (machine) => machine.connectionState === "connected" && supports.has(machine.id),
  );
  const results = useQueries({
    queries: asked.map((machine) =>
      planLimitsQueryOptions(machine.id as EnvironmentId, { signInsOnly: false, enabled }),
    ),
  });

  const byId = new Map<string, (typeof results)[number]>();
  asked.forEach((machine, index) => byId.set(machine.id, results[index]!));
  // Plain values each render: callers act on what the rules decide, not on this array.
  const computers = machines.map(
    (machine): PlanComputer => ({
      environmentId: machine.id,
      name: machine.name,
      connected: machine.connectionState === "connected",
      accounts: byId.get(machine.id)?.data?.accounts ?? null,
    }),
  );
  return {
    computers,
    pending: enabled && results.some((result) => result.isPending && !result.isError),
  };
}
