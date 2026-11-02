import { createFileRoute } from "@tanstack/react-router";

import {
  parsePullRequestsSearch,
  PullRequestsView,
} from "../components/pullRequest/PullRequestsView";

// Dev mode: pull requests on the services the person connected.
export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (search: Record<string, unknown>) => parsePullRequestsSearch(search),
  component: PullRequestsRouteView,
});

function PullRequestsRouteView() {
  return <PullRequestsView search={Route.useSearch()} />;
}
