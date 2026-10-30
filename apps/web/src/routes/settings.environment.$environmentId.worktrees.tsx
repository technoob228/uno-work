import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { WorktreesSettingsPanel } from "../components/settings/WorktreesSettings";
import { SIMPLE_SETTINGS_LANDING } from "../components/settings/settingsNavGroups";
import { readDevMode } from "../devMode";

function EnvironmentWorktreesRoute() {
  const { environmentId } = Route.useParams();
  return <WorktreesSettingsPanel environmentId={environmentId as EnvironmentId} />;
}

export const Route = createFileRoute("/settings/environment/$environmentId/worktrees")({
  beforeLoad: () => {
    if (!readDevMode()) throw redirect({ to: SIMPLE_SETTINGS_LANDING, replace: true });
  },
  component: EnvironmentWorktreesRoute,
});
