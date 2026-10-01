import { createFileRoute } from "@tanstack/react-router";

import { AiSettings } from "../components/settings/SimpleSettings";

export const Route = createFileRoute("/settings/ai")({
  component: AiSettings,
});
