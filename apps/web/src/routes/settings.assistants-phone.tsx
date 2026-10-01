import { createFileRoute } from "@tanstack/react-router";

import { AssistantsPhoneSettings } from "../components/settings/SimpleSettings";

export const Route = createFileRoute("/settings/assistants-phone")({
  component: AssistantsPhoneSettings,
});
