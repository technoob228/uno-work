import { createFileRoute, redirect } from "@tanstack/react-router";

import { SIMPLE_SETTINGS_PATHS } from "../components/settings/settingsNavGroups";

// One Projects page now; saved links and "last page" memory still land here.
export const Route = createFileRoute("/settings/environment/$environmentId/projects")({
  beforeLoad: () => {
    throw redirect({ to: SIMPLE_SETTINGS_PATHS.projects, replace: true });
  },
});
