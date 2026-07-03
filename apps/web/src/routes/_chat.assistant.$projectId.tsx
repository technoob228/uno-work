import { createFileRoute } from "@tanstack/react-router";

import { AssistantConfig } from "../components/AssistantConfig";

function AssistantConfigRoute() {
  const { projectId } = Route.useParams();
  return <AssistantConfig projectId={projectId} />;
}

export const Route = createFileRoute("/_chat/assistant/$projectId")({
  component: AssistantConfigRoute,
});
