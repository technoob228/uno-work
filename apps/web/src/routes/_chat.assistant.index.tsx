import { createFileRoute } from "@tanstack/react-router";

import { ManagerPanel } from "../components/ManagerPanel";

export const Route = createFileRoute("/_chat/assistant/")({
  component: ManagerPanel,
});
