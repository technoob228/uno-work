import { createFileRoute } from "@tanstack/react-router";

import { OfficeView } from "../components/office/OfficeView";

export interface OfficeRouteSearch {
  path: string;
}

export const Route = createFileRoute("/_chat/office")({
  validateSearch: (search: Record<string, unknown>): OfficeRouteSearch => ({
    path: typeof search.path === "string" ? search.path : "",
  }),
  component: OfficeRouteView,
});

function OfficeRouteView() {
  const { path } = Route.useSearch();
  // key: другой файл — новый экземпляр редактора, без переноса состояния.
  return <OfficeView key={path} path={path} />;
}
