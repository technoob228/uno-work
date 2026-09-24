import { createFileRoute } from "@tanstack/react-router";

import { MyUnoView } from "../components/myuno/MyUnoView";

export interface MyUnoRouteSearch {
  /** "billing" opens Plan & billing; nothing = the overview. */
  readonly tab?: "billing";
  /** The overview's section: nothing = Computers. */
  readonly section?: "sites" | "cloud";
}

export const Route = createFileRoute("/_chat/my-uno")({
  validateSearch: (search: Record<string, unknown>): MyUnoRouteSearch => {
    if (search["tab"] === "billing") return { tab: "billing" };
    const section = search["section"];
    return section === "sites" || section === "cloud" ? { section } : {};
  },
  component: MyUnoView,
});
