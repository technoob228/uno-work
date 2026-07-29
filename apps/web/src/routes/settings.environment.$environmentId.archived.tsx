import { createFileRoute } from "@tanstack/react-router";

import { ArchivedThreadsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/environment/$environmentId/archived")({
  component: ArchivedThreadsPanel,
});
