/**
 * "Sites" and "Cloud" on My Uno. Sites live on Uno Hosting — no computer
 * needed, they stay up while every computer sleeps. Open one inside Uno, copy
 * its address, or update it from a folder on the computer you're on (the same
 * publish as Files → Share → Publish as a website, to the same address).
 */
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CloudIcon, ExternalLinkIcon, GlobeIcon, LockIcon, UploadIcon } from "lucide-react";
import { useState } from "react";

import {
  type CloudUsage,
  type HostedSite,
  type SitesState,
  consoleLinks,
} from "../../account/accountOverview";
import { formatBytes } from "../../account/billingModel";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { openInNewTab, useOpenApp } from "../../navigation/useOpenApp";
import { useStore } from "../../store";
import { formatElapsedAgoLabel } from "../../timestampFormat";
import { ChatInFolderDialog } from "../computer/ChatInFolderDialog";
import { CopyButton, Meter } from "../computer/computerUi";
import { filesApi } from "../files/filesApi";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { toastManager } from "../ui/toast";
import { myUnoKeys } from "./myUnoQueries";

function SiteRow({ site, onUpdate }: { site: HostedSite; onUpdate: () => void }) {
  const { openHere } = useOpenApp();
  const host = site.url.replace(/^https?:\/\//, "");
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2.5" data-testid="my-uno-site">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-500">
        <GlobeIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-sm font-medium">
          <span className="truncate">{site.slug}</span>
          {site.hasPassword ? (
            <LockIcon className="size-3 text-muted-foreground" aria-label="Password protected" />
          ) : null}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {host} · {formatBytes(site.sizeBytes)}
          {site.updatedAt ? ` · updated ${formatElapsedAgoLabel(site.updatedAt)}` : ""}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Button
          size="xs"
          variant="outline"
          onClick={() => openHere({ url: site.url, name: site.slug })}
        >
          Open
        </Button>
        <Button size="xs" variant="ghost" onClick={onUpdate}>
          <UploadIcon />
          Update
        </Button>
        <CopyButton value={site.url} label={`address of ${site.slug}`} />
      </span>
    </li>
  );
}

export function SitesSection({
  data,
  loading,
  error,
}: {
  data: SitesState | undefined;
  loading: boolean;
  error: unknown;
}) {
  const queryClient = useQueryClient();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primaryEnvironmentId;
  const [updating, setUpdating] = useState<HostedSite | null>(null);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="my-uno-sites">
      <header className="flex items-center gap-2">
        <h2 id="my-uno-sites" className="text-sm font-semibold">
          Sites
        </h2>
        <span className="text-xs text-muted-foreground">
          {data ? `${data.sites.length} on Uno Hosting` : ""}
        </span>
        <Button size="sm" variant="ghost" className="ml-auto" render={<Link to="/files" />}>
          <UploadIcon />
          Publish a site
        </Button>
      </header>
      {loading ? (
        <Skeleton className="h-20 w-full rounded-2xl" />
      ) : error ? (
        <p className="rounded-2xl border border-border/60 px-4 py-3 text-xs text-muted-foreground">
          Couldn't read your sites just now.{" "}
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => openInNewTab(consoleLinks.sites)}
          >
            See them in the console
          </button>
          .
        </p>
      ) : !data || data.sites.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border/80 px-4 py-5 text-center text-xs text-muted-foreground">
          No sites yet. In Files, pick a page or a folder and choose Share → Publish as a website —
          it gets its own address and stays up even when your computers sleep.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-2xl border border-border/60 bg-card/40">
          {data.sites.map((site) => (
            <SiteRow key={site.slug} site={site} onUpdate={() => setUpdating(site)} />
          ))}
        </ul>
      )}
      <ChatInFolderDialog
        environmentId={environmentId}
        open={updating !== null}
        onOpenChange={(open) => (open ? null : setUpdating(null))}
        title={updating ? `Update ${updating.slug}` : "Update a site"}
        description="Pick the folder with the new version on this computer. Its files replace what the site shows now, at the same address."
        actionLabel={(folder) => `Publish ${folder}`}
        actionIcon={<UploadIcon />}
        errorFallback="Couldn't publish the site."
        onStart={async (folder) => {
          if (!updating) return;
          const result = await filesApi(environmentId).publishSite({
            path: folder,
            slug: updating.slug,
          });
          toastManager.add({
            type: "success",
            title: `${result.slug} is updated`,
            description: `${result.filesCount} files are live at ${result.url.replace(/^https?:\/\//, "")}.`,
          });
          void queryClient.invalidateQueries({ queryKey: myUnoKeys.sites });
        }}
      />
    </section>
  );
}

export function CloudCard({
  data,
  planCloudGb,
}: {
  data: CloudUsage | undefined;
  planCloudGb: number | null;
}) {
  const quota =
    data && data.quotaBytes > 0 ? data.quotaBytes : planCloudGb ? planCloudGb * 1024 ** 3 : 0;
  const used = data?.usedBytes ?? 0;
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : null;
  return (
    <Link
      to="/files"
      search={{ cloud: "1" }}
      className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/40 px-4 py-3 transition-colors hover:bg-accent/40"
      data-testid="my-uno-cloud"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/10">
        <CloudIcon className="size-4.5 text-sky-500" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">Cloud</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {data
              ? quota > 0
                ? `${formatBytes(used)} of ${formatBytes(quota)} used`
                : `${formatBytes(used)} used`
              : "…"}
          </span>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          One storage for the whole account — every computer and app sees it.
        </span>
        {pct !== null ? <Meter value={pct} className="mt-1.5 max-w-sm" /> : null}
      </span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        Open in Files
        <ExternalLinkIcon className="size-3" />
      </span>
    </Link>
  );
}
