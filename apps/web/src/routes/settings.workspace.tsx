import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceSettings } from "../components/settings/WorkspaceSettings";

export const Route = createFileRoute("/settings/workspace")({
  component: WorkspaceSettings,
});
