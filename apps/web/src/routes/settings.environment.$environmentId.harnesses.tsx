import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { HarnessesSettingsPanel } from "../components/settings/HarnessesSettingsPanel";

function EnvironmentHarnessesRoute() {
  const { environmentId } = Route.useParams();
  return <HarnessesSettingsPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/harnesses")({
  component: EnvironmentHarnessesRoute,
});
