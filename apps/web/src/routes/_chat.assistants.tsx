import { createFileRoute } from "@tanstack/react-router";

import {
  AssistantsView,
  type AssistantsRouteSearch,
} from "../components/assistants/AssistantsView";

export const Route = createFileRoute("/_chat/assistants")({
  validateSearch: (search: Record<string, unknown>): AssistantsRouteSearch => {
    const view = search["view"];
    const box = Number(search["box"]);
    if (view === "assistant") {
      return Number.isInteger(box) && box > 0 ? { view, box } : {};
    }
    const project = search["project"];
    if (view === "local") {
      return typeof project === "string" && project.startsWith("assistant-")
        ? { view, project }
        : {};
    }
    return view === "new" || view === "here" || view === "card" ? { view } : {};
  },
  component: AssistantsView,
});
