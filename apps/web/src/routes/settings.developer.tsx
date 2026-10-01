import { createFileRoute } from "@tanstack/react-router";

import { DeveloperSettings } from "../components/settings/SimpleSettings";

export const Route = createFileRoute("/settings/developer")({
  component: DeveloperSettings,
});
