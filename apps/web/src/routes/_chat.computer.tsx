import { createFileRoute } from "@tanstack/react-router";

import { ComputerView } from "../components/computer/ComputerView";

export interface ComputerRouteSearch {
  /** "1" = open the App Store over the desktop (the sidebar's App Store row). */
  readonly store?: "1";
}

export const Route = createFileRoute("/_chat/computer")({
  validateSearch: (search: Record<string, unknown>): ComputerRouteSearch =>
    search["store"] === "1" || search["store"] === 1 ? { store: "1" } : {},
  component: ComputerView,
});
