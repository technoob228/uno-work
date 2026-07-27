import { createFileRoute } from "@tanstack/react-router";

import { AssistantSettingsPanel } from "../components/settings/AssistantSettingsPanel";
import { usePrimaryEnvironmentId } from "../environments/primary";

/**
 * Capability tokens are daemon state, so the panel needs an environment. This
 * app-scoped route names the primary one explicitly — the same daemon it has
 * always read, now stated rather than inferred from the request origin.
 */
function AssistantSettingsRoute() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (!primaryEnvironmentId) return null;
  return <AssistantSettingsPanel environmentId={primaryEnvironmentId} />;
}

export const Route = createFileRoute("/settings/assistant")({
  component: AssistantSettingsRoute,
});
