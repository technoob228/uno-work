/**
 * Links around Office: the standalone editor tab and the AGPL source notice.
 */
import type { OfficeCloudRef } from "./officeCloud";

/**
 * Where our changes to ONLYOFFICE are published (AGPL-3.0 §13): the runtime
 * patches Work applies to the editor, how we package and serve the engine.
 */
export const OFFICE_SOURCE_URL = "https://github.com/technoob228/onlyoffice-uno-patches";
export const OFFICE_SOURCE_LABEL = "Open source: ONLYOFFICE (AGPL) — our changes";

/**
 * `/office?…&tab=1` — the same editor without the app around it, for a
 * separate browser tab. Same origin, so it needs the same Work session
 * (signed out, the pair page brings the person back here after Sign in with
 * Uno). `env` is set when the document is on another computer than the one
 * this page belongs to.
 */
export function officeStandaloneHref(input: {
  readonly path: string;
  readonly cloud?: OfficeCloudRef | undefined;
  readonly environmentId?: string | null | undefined;
  readonly primaryEnvironmentId?: string | null | undefined;
}): string {
  const params = new URLSearchParams();
  if (input.cloud) {
    params.set("bucket", String(input.cloud.bucketId));
    params.set("key", input.cloud.key);
  } else {
    params.set("path", input.path);
  }
  params.set("tab", "1");
  if (input.environmentId && input.environmentId !== input.primaryEnvironmentId) {
    params.set("env", input.environmentId);
  }
  return `/office?${params.toString()}`;
}

/** Is this the standalone editor tab? (`/office?…&tab=1`) */
export function isOfficeStandaloneLocation(pathname: string, search: unknown): boolean {
  if (pathname !== "/office" || typeof search !== "object" || search === null) return false;
  const tab = (search as Record<string, unknown>).tab;
  return tab === true || tab === 1 || tab === "1";
}
