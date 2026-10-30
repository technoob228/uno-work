import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { ProjectsSettingsPanel } from "../components/settings/ProjectsSettings";
import { SIMPLE_SETTINGS_LANDING } from "../components/settings/settingsNavGroups";
import { readDevMode } from "../devMode";

function EnvironmentProjectsRoute() {
  const { environmentId } = Route.useParams();
  return <ProjectsSettingsPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/projects")({
  beforeLoad: () => {
    if (!readDevMode()) throw redirect({ to: SIMPLE_SETTINGS_LANDING, replace: true });
  },
  component: EnvironmentProjectsRoute,
});
