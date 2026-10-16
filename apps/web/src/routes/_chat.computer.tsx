import { createFileRoute } from "@tanstack/react-router";

import { ComputerView } from "../components/computer/ComputerView";
import {
  parseResourceLook,
  type ResourceLook,
} from "../components/computer/resources/resourceModel";

export interface ComputerRouteSearch {
  /** "1" = open the App Store over the desktop (the sidebar's App Store row). */
  readonly store?: "1";
  /** An app's settings (⚙) to open, by its tile key — from the sidebar and Apps & sites. */
  readonly app?: string;
  /** What's using the computer: the processor / memory / disk / network drill-down. */
  readonly look?: ResourceLook;
}

export const Route = createFileRoute("/_chat/computer")({
  validateSearch: (search: Record<string, unknown>): ComputerRouteSearch => {
    const look = parseResourceLook(search["look"]);
    return {
      ...(search["store"] === "1" || search["store"] === 1 ? { store: "1" as const } : {}),
      ...(look ? { look } : {}),
      ...(typeof search["app"] === "string" ? { app: search["app"].slice(0, 200) } : {}),
    };
  },
  component: ComputerView,
});
