import { createFileRoute } from "@tanstack/react-router";

import { LabsSettingsPanel } from "../components/settings/LabsSettingsPanel";

export const Route = createFileRoute("/settings/app/labs")({
  component: LabsSettingsPanel,
});
