import { createFileRoute } from "@tanstack/react-router";

import { OfficeView } from "../components/office/OfficeView";

/**
 * `/office?path=<file on the computer>` or, for a document in Cloud storage,
 * `/office?bucket=<bucket id>&key=<object key>`.
 */
export interface OfficeRouteSearch {
  path?: string;
  bucket?: number;
  key?: string;
}

export const Route = createFileRoute("/_chat/office")({
  validateSearch: (search: Record<string, unknown>): OfficeRouteSearch => {
    const bucket = Number(search.bucket);
    const key = typeof search.key === "string" ? search.key : "";
    if (Number.isInteger(bucket) && bucket > 0 && key && !key.endsWith("/") && key.length <= 1024) {
      return { bucket, key };
    }
    return { path: typeof search.path === "string" ? search.path : "" };
  },
  component: OfficeRouteView,
});

function OfficeRouteView() {
  const { path, bucket, key } = Route.useSearch();
  // key: другой файл — новый экземпляр редактора, без переноса состояния.
  if (bucket !== undefined && key !== undefined) {
    return (
      <OfficeView key={`cloud:${bucket}:${key}`} path={key} cloud={{ bucketId: bucket, key }} />
    );
  }
  return <OfficeView key={path ?? ""} path={path ?? ""} />;
}
