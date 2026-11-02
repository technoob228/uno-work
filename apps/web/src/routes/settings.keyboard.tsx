import { createFileRoute } from "@tanstack/react-router";

import { KeyboardSettings } from "../components/settings/KeyboardSettings";

export const Route = createFileRoute("/settings/keyboard")({
  component: KeyboardSettings,
});
