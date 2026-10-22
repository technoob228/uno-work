import { createFileRoute } from "@tanstack/react-router";

import { ConnectorsSettings } from "../components/settings/ConnectorsSettings";

export const Route = createFileRoute("/settings/connectors")({
  component: ConnectorsSettings,
});
