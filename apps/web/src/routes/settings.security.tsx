import { createFileRoute } from "@tanstack/react-router";

import { SecuritySettings } from "../components/settings/security/SecuritySettings";

export const Route = createFileRoute("/settings/security")({
  component: SecuritySettings,
});
