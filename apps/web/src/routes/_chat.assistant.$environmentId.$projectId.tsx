import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { AssistantConfig } from "../components/AssistantConfig";

/**
 * An assistant is identified by the environment that owns it *and* its
 * project id: project ids are unique per daemon, not globally. Keeping the
 * environment in the path is what makes a refresh, a bookmark, and
 * back/forward all land on the same machine's assistant.
 */
function AssistantConfigRoute() {
  const { environmentId, projectId } = Route.useParams();
  return <AssistantConfig environmentId={environmentId as EnvironmentId} projectId={projectId} />;
}

export const Route = createFileRoute("/_chat/assistant/$environmentId/$projectId")({
  component: AssistantConfigRoute,
});
