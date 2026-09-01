import { createFileRoute } from "@tanstack/react-router";

import { ExtensionsSettingsPanel } from "../components/settings/ExtensionsSettingsPanel";

export const Route = createFileRoute("/settings/extensions")({
  component: ExtensionsSettingsPanel,
});
