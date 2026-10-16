/** Small Pult hooks for the rest of Work (the sidebar row and its count). */
import { useDemoSwitch } from "../demo/demoFlag";
import { openNeeds } from "./pult.logic";
import { effectiveTasks, usePultStore } from "./pultStore";

/** The Pult has its own row in the sidebar when it is shown as a screen in the middle. */
export function usePultPlace(): boolean {
  const hasData = usePultStore((s) => s.data !== null);
  return hasData && useDemoSwitch("pult") === "center";
}

/** How many requests wait for the owner (the number next to "Пульт"). */
export function usePultNeedsCount(): number {
  return usePultStore((s) => openNeeds(effectiveTasks(s)).length);
}
