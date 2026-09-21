import { createFileRoute } from "@tanstack/react-router";

import { ComputerView } from "../components/computer/ComputerView";

export const Route = createFileRoute("/_chat/computer")({
  component: ComputerView,
});
