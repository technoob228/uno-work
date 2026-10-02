import { createFileRoute } from "@tanstack/react-router";

import { SitesListView } from "../components/sites/SitesListView";

export const Route = createFileRoute("/_chat/sites")({
  component: SitesListView,
});
