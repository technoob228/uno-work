import { createFileRoute } from "@tanstack/react-router";

import { FilesView } from "../components/files/FilesView";
import { parseFilesRouteSearch } from "../components/files/filesRouteSearch";

export const Route = createFileRoute("/_chat/files")({
  validateSearch: (search) => parseFilesRouteSearch(search),
  component: FilesView,
});
