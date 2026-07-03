import { createFileRoute } from "@tanstack/react-router";

import { AssistantSettingsPanel } from "../components/settings/AssistantSettingsPanel";

export const Route = createFileRoute("/settings/assistant")({
  component: AssistantSettingsPanel,
});
