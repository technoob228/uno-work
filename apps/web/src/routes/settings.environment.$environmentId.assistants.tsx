import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AssistantSettingsPanel } from "../components/settings/AssistantSettingsPanel";

function EnvironmentAssistantsRoute() {
  const { environmentId } = Route.useParams();
  return <AssistantSettingsPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/assistants")({
  component: EnvironmentAssistantsRoute,
});
