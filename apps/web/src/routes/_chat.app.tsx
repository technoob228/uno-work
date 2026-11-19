import { createFileRoute } from "@tanstack/react-router";

import { AppView } from "../components/apps/AppView";
import { parseAppUrl } from "../components/apps/appAddress";

export interface AppRouteSearch {
  readonly url?: string;
  /** A tile of the computer (`ProgramTile.key`): started if needed, then shown. */
  readonly app?: string;
  /** The computer it is on (its environment id): the same app id can be on several. */
  readonly env?: string;
  readonly name?: string;
  readonly icon?: string;
}

/**
 * `/app?url=<app address>&name=<name>&icon=<emoji>` — an app inside Uno Work;
 * `/app?app=<tile key>[&env=<computer>]` — an app by its tile, on whichever
 * of the person's computers it is (workspaceApps.ts).
 */
export const Route = createFileRoute("/_chat/app")({
  validateSearch: (search: Record<string, unknown>): AppRouteSearch => {
    const url = parseAppUrl(search["url"]);
    const name = typeof search["name"] === "string" ? search["name"].slice(0, 120) : undefined;
    const icon = typeof search["icon"] === "string" ? search["icon"].slice(0, 16) : undefined;
    const app = typeof search["app"] === "string" ? search["app"].slice(0, 200) : undefined;
    const env =
      typeof search["env"] === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(search["env"])
        ? search["env"]
        : undefined;
    return {
      ...(url ? { url } : {}),
      ...(app ? { app } : {}),
      ...(env ? { env } : {}),
      ...(name ? { name } : {}),
      ...(icon ? { icon } : {}),
    };
  },
  component: AppView,
});
