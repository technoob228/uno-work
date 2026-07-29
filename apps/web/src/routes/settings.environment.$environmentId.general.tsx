import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentGeneralSettings } from "../components/settings/EnvironmentGeneralSettings";

function EnvironmentGeneralRoute() {
  const { environmentId } = Route.useParams();
  return <EnvironmentGeneralSettings environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/general")({
  component: EnvironmentGeneralRoute,
});
