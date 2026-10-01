import { createFileRoute } from "@tanstack/react-router";

import { useDevMode } from "../devMode";
import { PhoneSettingsPanel } from "../components/settings/PhoneSettingsPanel";
import { AssistantsPhoneSettings } from "../components/settings/SimpleSettings";

/** 01.10: pairing the T3 Code app is for Dev mode; otherwise Telegram and the phone QR. */
function PhoneRoute() {
  return useDevMode() ? <PhoneSettingsPanel /> : <AssistantsPhoneSettings />;
}

export const Route = createFileRoute("/settings/app/phone")({
  component: PhoneRoute,
});
