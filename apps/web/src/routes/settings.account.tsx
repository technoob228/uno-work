import { createFileRoute } from "@tanstack/react-router";

import { AccountPlanSettings } from "../components/settings/SimpleSettings";

export const Route = createFileRoute("/settings/account")({
  component: AccountPlanSettings,
});
