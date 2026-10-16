import { createFileRoute, redirect } from "@tanstack/react-router";

import { ConnectorsSettings } from "../components/settings/ConnectorsSettings";
import { DEMO } from "../demo/demoFlag";

// Settings → Connectors is only in the mock for now (Misha 16.10: the team
// and its access ship later); the release has no such page.
export const Route = createFileRoute("/settings/connectors")({
  beforeLoad: () => {
    if (!DEMO) throw redirect({ to: "/settings", replace: true });
  },
  component: ConnectorsSettings,
});
