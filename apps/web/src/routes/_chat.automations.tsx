import { createFileRoute } from "@tanstack/react-router";

import { AutomationsView, parseAutomationsSearch } from "../components/automations/AutomationsView";

// Automations (28.10): what the assistants do by themselves, on every computer.
export const Route = createFileRoute("/_chat/automations")({
  validateSearch: (search: Record<string, unknown>) => parseAutomationsSearch(search),
  component: AutomationsRouteView,
});

function AutomationsRouteView() {
  return <AutomationsView search={Route.useSearch()} />;
}
