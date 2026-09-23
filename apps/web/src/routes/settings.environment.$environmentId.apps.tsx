import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AppsAiSettingsPanel } from "../components/settings/AppsAiSettingsPanel";

function EnvironmentAppsRoute() {
  const { environmentId } = Route.useParams();
  return <AppsAiSettingsPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/apps")({
  component: EnvironmentAppsRoute,
});
