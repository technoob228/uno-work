import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceView } from "../workspace/WorkspaceView";

export interface WorkspaceRouteSearch {
  /** Nothing = Apps. */
  readonly tab?: "hardware";
  /** An app's card is open. */
  readonly app?: string;
  /** A computer's card is open. */
  readonly computer?: string;
}

const id = (value: unknown) =>
  typeof value === "string" && /^[\w.-]{1,64}$/.test(value) ? value : undefined;

export const Route = createFileRoute("/_chat/workspace")({
  validateSearch: (search: Record<string, unknown>): WorkspaceRouteSearch => {
    const app = id(search["app"]);
    const computer = id(search["computer"]);
    return {
      ...(search["tab"] === "hardware" ? { tab: "hardware" as const } : {}),
      ...(app ? { app } : {}),
      ...(computer ? { computer } : {}),
    };
  },
  component: WorkspaceView,
});
