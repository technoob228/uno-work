import { createFileRoute } from "@tanstack/react-router";

import { MyComputerTrustSettings } from "../components/settings/MyComputerTrustSettings";

export const Route = createFileRoute("/settings/my-computer")({
  component: MyComputerTrustSettings,
});
