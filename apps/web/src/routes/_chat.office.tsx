import { createFileRoute } from "@tanstack/react-router";

import { OfficeView } from "../components/office/OfficeView";

/**
 * `/office?path=<file on the computer>` or, for a document in Cloud storage,
 * `/office?bucket=<bucket id>&key=<object key>`. `tab=1` is the standalone
 * editor (no sidebar; "Open in a new tab"), `env=<environment id>` the
 * computer the file is on when it isn't this page's own.
 */
export interface OfficeRouteSearch {
  path?: string;
  bucket?: number;
  key?: string;
  tab?: boolean;
  env?: string;
}

const ENVIRONMENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const Route = createFileRoute("/_chat/office")({
  validateSearch: (search: Record<string, unknown>): OfficeRouteSearch => {
    const extra: Pick<OfficeRouteSearch, "tab" | "env"> = {};
    if (search.tab === true || search.tab === 1 || search.tab === "1") extra.tab = true;
    if (typeof search.env === "string" && ENVIRONMENT_ID.test(search.env)) extra.env = search.env;
    const bucket = Number(search.bucket);
    const key = typeof search.key === "string" ? search.key : "";
    if (Number.isInteger(bucket) && bucket > 0 && key && !key.endsWith("/") && key.length <= 1024) {
      return { bucket, key, ...extra };
    }
    return { path: typeof search.path === "string" ? search.path : "", ...extra };
  },
  component: OfficeRouteView,
});

function OfficeRouteView() {
  const { path, bucket, key, tab, env } = Route.useSearch();
  const standalone = tab === true;
  // key: другой файл — новый экземпляр редактора, без переноса состояния.
  if (bucket !== undefined && key !== undefined) {
    return (
      <OfficeView
        key={`cloud:${bucket}:${key}`}
        path={key}
        cloud={{ bucketId: bucket, key }}
        standalone={standalone}
        environmentOverride={env}
      />
    );
  }
  return (
    <OfficeView
      key={path ?? ""}
      path={path ?? ""}
      standalone={standalone}
      environmentOverride={env}
    />
  );
}
