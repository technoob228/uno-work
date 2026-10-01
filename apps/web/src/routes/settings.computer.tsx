import { createFileRoute } from "@tanstack/react-router";

import { ComputerSettings } from "../components/settings/SimpleSettings";

export const Route = createFileRoute("/settings/computer")({
  component: ComputerSettings,
});
