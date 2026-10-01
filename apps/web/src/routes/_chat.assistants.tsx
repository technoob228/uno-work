import { createFileRoute } from "@tanstack/react-router";

import {
  AssistantsView,
  type AssistantsRouteSearch,
} from "../components/assistants/AssistantsView";

export const Route = createFileRoute("/_chat/assistants")({
  validateSearch: (search: Record<string, unknown>): AssistantsRouteSearch => {
    const view = search["view"];
    return view === "new" || view === "card" ? { view } : {};
  },
  component: AssistantsView,
});
