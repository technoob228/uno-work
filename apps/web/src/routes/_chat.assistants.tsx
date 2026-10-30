import { createFileRoute } from "@tanstack/react-router";

import {
  AssistantsView,
  type AssistantsRouteSearch,
} from "../components/assistants/AssistantsView";
import { assistantProfileTab } from "../components/assistants/assistantSettingsNav.logic";

export const Route = createFileRoute("/_chat/assistants")({
  validateSearch: (search: Record<string, unknown>): AssistantsRouteSearch => {
    const view = search["view"];
    const box = Number(search["box"]);
    if (view === "assistant") {
      return Number.isInteger(box) && box > 0 ? { view, box } : {};
    }
    const project = search["project"];
    const env = search["env"];
    if (view === "profile") {
      // Only the id itself: a hash URL may carry the page's own query after it.
      const projectId =
        typeof project === "string" ? /^assistant-[\w-]+/.exec(project)?.[0] : undefined;
      const environmentId = typeof env === "string" ? /^[\w.:-]+/.exec(env)?.[0] : undefined;
      // Its page opens on a tab (?tab=…, 29.10); none or unknown = General.
      const tab = assistantProfileTab(search["tab"]);
      return projectId && environmentId
        ? { view, project: projectId, env: environmentId, ...(tab !== "general" ? { tab } : {}) }
        : {};
    }
    if (view === "uno-setup") {
      // Uno's first-run screen (assistants D); without `env`: the active computer.
      const environmentId = typeof env === "string" ? /^[\w.:-]+/.exec(env)?.[0] : undefined;
      return environmentId ? { view, env: environmentId } : { view };
    }
    if (view === "local") {
      return typeof project === "string" && project.startsWith("assistant-")
        ? { view, project }
        : {};
    }
    return view === "new" || view === "here" || view === "card" ? { view } : {};
  },
  component: AssistantsView,
});
