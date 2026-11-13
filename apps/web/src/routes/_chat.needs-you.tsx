import { createFileRoute } from "@tanstack/react-router";

import { NeedsYouView } from "../components/needsYou/NeedsYouView";

// Needs you (Misha 13.11, the Pult redo): what waits on the person, everywhere.
export const Route = createFileRoute("/_chat/needs-you")({
  component: NeedsYouView,
});
