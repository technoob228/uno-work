import { createFileRoute } from "@tanstack/react-router";

import { ProtoProjectsPage } from "../proto/ProtoProjectsPage";

// Sidebar prototype (w0115, not for merge): variant E — projects as a place.
export const Route = createFileRoute("/_chat/projects")({
  component: ProtoProjectsPage,
});
