import { createFileRoute } from "@tanstack/react-router";

import { DriveView } from "../components/drive/DriveView";
import { parseDriveRouteSearch } from "../components/drive/driveApi";

export const Route = createFileRoute("/_chat/drive")({
  validateSearch: (search) => parseDriveRouteSearch(search),
  component: DriveView,
});
