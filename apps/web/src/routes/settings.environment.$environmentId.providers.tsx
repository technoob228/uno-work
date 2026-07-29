import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentProvidersPanel } from "../components/settings/EnvironmentProvidersPanel";

function EnvironmentProvidersRoute() {
  const { environmentId } = Route.useParams();
  return <EnvironmentProvidersPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/providers")({
  component: EnvironmentProvidersRoute,
});
