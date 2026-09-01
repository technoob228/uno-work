import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";

function EnvironmentSourceControlRoute() {
  const { environmentId } = Route.useParams();
  return <SourceControlSettingsPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/source-control")({
  component: EnvironmentSourceControlRoute,
});
