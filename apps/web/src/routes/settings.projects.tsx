import { createFileRoute } from "@tanstack/react-router";

import { ProjectsListSettings } from "../components/settings/ProjectsListSettings";

export const Route = createFileRoute("/settings/projects")({
  component: ProjectsListSettings,
});
