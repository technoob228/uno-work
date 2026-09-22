import { createFileRoute } from "@tanstack/react-router";

import { MachineAccessSettings } from "../components/settings/MachineAccessSettings";

export const Route = createFileRoute("/settings/computer-access")({
  component: MachineAccessSettings,
});
