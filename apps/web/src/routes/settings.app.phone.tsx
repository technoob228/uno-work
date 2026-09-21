import { createFileRoute } from "@tanstack/react-router";

import { PhoneSettingsPanel } from "../components/settings/PhoneSettingsPanel";

export const Route = createFileRoute("/settings/app/phone")({
  component: PhoneSettingsPanel,
});
