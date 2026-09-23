/**
 * An .html file in the right panel, shown from its own folder on the daemon
 * (`/api/preview-site`), so `assets/style.css`, images and fonts next to it
 * load like in a browser. The frame keeps the sandbox its caller had (the
 * right panel runs no scripts; the Files viewer runs them in an opaque
 * origin). Where the daemon can't be reached over HTTP (an older daemon, a proxy
 * that passes only the socket), the page is drawn from its text as before.
 */
import { PREVIEW_SITE_ROUTE_PREFIX, type EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { environmentFetchJson, resolveEnvironmentHttpTarget } from "../../environments/http/target";
import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";

async function previewSiteUrl(environmentId: EnvironmentId, path: string): Promise<string> {
  const { url } = await environmentFetchJson<{ url: string }>({
    environmentId,
    pathname: PREVIEW_SITE_ROUTE_PREFIX,
    method: "POST",
    body: { path },
  });
  const target = await resolveEnvironmentHttpTarget(environmentId);
  if (target.kind === "primary") return resolvePrimaryEnvironmentHttpUrl(url);
  return new URL(url, target.httpBaseUrl).toString();
}

export function HtmlFileFrame(props: {
  readonly name: string;
  readonly environmentId: EnvironmentId | undefined;
  readonly path: string | undefined;
  /** The page's text: the fallback, and a new version reloads the frame. */
  readonly content: string;
  readonly fallbackSrcDoc: string;
  /** The frame's sandbox: "" (right panel: no scripts) or what the Files viewer allows. */
  readonly sandbox?: string;
}) {
  const sandbox = props.sandbox ?? "";
  const { environmentId, path } = props;
  const site = useQuery({
    queryKey: ["previewSiteUrl", environmentId, path],
    queryFn: () => previewSiteUrl(environmentId!, path!),
    enabled: Boolean(environmentId && path),
    staleTime: 60 * 60_000,
    retry: false,
  });
  if (site.isPending && environmentId && path) {
    return <div className="h-full w-full bg-background" />;
  }
  if (!site.data) {
    return (
      <iframe
        title={props.name}
        srcDoc={props.fallbackSrcDoc}
        sandbox={sandbox}
        className="h-full w-full border-0"
      />
    );
  }
  // A new version of the file (the agent edited it) reloads the page.
  const version = `${props.content.length}:${hash(props.content)}`;
  return (
    <iframe
      key={version}
      title={props.name}
      src={site.data}
      sandbox={sandbox}
      referrerPolicy="no-referrer"
      className="h-full w-full border-0 bg-white"
      data-testid="html-preview-site"
    />
  );
}

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (Math.imul(31, value) + text.charCodeAt(index)) | 0;
  }
  return value;
}
