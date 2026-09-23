import { createFileRoute } from "@tanstack/react-router";

import { MyUnoView } from "../components/myuno/MyUnoView";

export interface MyUnoRouteSearch {
  /** "billing" opens Plan & billing; nothing = the overview. */
  readonly tab?: "billing";
}

export const Route = createFileRoute("/_chat/my-uno")({
  validateSearch: (search: Record<string, unknown>): MyUnoRouteSearch =>
    search["tab"] === "billing" ? { tab: "billing" } : {},
  component: MyUnoView,
});
