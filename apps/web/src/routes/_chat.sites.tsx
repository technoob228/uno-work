import { createFileRoute } from "@tanstack/react-router";

import { SitesListView } from "../components/sites/SitesListView";
import { parseAppsSitesSearch } from "../components/sites/sitesModel";

// "Apps & sites" (sidebar D): one place, two tabs. `/sites` keeps its name so
// older links ("Saved to Sites") still land here.
export const Route = createFileRoute("/_chat/sites")({
  validateSearch: (search) => parseAppsSitesSearch(search),
  component: SitesListView,
});
