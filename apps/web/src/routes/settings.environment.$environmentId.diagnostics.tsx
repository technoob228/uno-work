import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { DiagnosticsSettingsPanel } from "../components/settings/DiagnosticsSettings";
import { SIMPLE_SETTINGS_LANDING } from "../components/settings/settingsNavGroups";
import { readDevMode } from "../devMode";

function EnvironmentDiagnosticsRoute() {
  const { environmentId } = Route.useParams();
  return <DiagnosticsSettingsPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/diagnostics")({
  beforeLoad: () => {
    if (!readDevMode()) throw redirect({ to: SIMPLE_SETTINGS_LANDING, replace: true });
  },
  component: EnvironmentDiagnosticsRoute,
});
