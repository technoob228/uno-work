import { createFileRoute } from "@tanstack/react-router";

import { AppView } from "../components/apps/AppView";
import { parseAppUrl } from "../components/apps/appAddress";

export interface AppRouteSearch {
  readonly url?: string;
  readonly name?: string;
  readonly icon?: string;
}

/** `/app?url=<app address>&name=<name>&icon=<emoji>` — an app inside Uno Work. */
export const Route = createFileRoute("/_chat/app")({
  validateSearch: (search: Record<string, unknown>): AppRouteSearch => {
    const url = parseAppUrl(search["url"]);
    const name = typeof search["name"] === "string" ? search["name"].slice(0, 120) : undefined;
    const icon = typeof search["icon"] === "string" ? search["icon"].slice(0, 16) : undefined;
    return {
      ...(url ? { url } : {}),
      ...(name ? { name } : {}),
      ...(icon ? { icon } : {}),
    };
  },
  component: AppView,
});
