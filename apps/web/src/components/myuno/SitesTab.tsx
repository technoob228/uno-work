/**
 * "Sites" on My Uno — one row per site on Uno Hosting. No computer needed:
 * they stay up while every computer sleeps. On hover: copy the address,
 * update it from a folder, open it inside Uno. A click opens the side panel.
 */
import { Link } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, GlobeIcon, LockIcon, UploadIcon } from "lucide-react";
import { useState } from "react";

import { type HostedSite, type SitesState, consoleLinks } from "../../account/accountOverview";
import { formatBytes } from "../../account/billingModel";
import { isWebLite } from "../../lite/flag";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { openInNewTab, useOpenApp } from "../../navigation/useOpenApp";
import { formatElapsedAgoLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { matchesSite } from "./myUnoModel";
import { GroupTitle, HOVER_ONLY, Row, RowList, SearchBox } from "./rowsUi";

export function siteHost(site: HostedSite): string {
  return site.url.replace(/^https?:\/\//, "");
}

export function SiteCopyButton({ site, withLabel }: { site: HostedSite; withLabel?: boolean }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  return (
    <Button
      size={withLabel ? "sm" : "icon-xs"}
      variant={withLabel ? "outline" : "ghost"}
      aria-label={`Copy the address of ${site.slug}`}
      onClick={() => copyToClipboard(site.url)}
    >
      {isCopied ? <CheckIcon /> : <CopyIcon />}
      {withLabel ? (isCopied ? "Copied" : "Copy link") : null}
    </Button>
  );
}

export function SitesTab({
  data,
  loading,
  error,
  selectedSlug,
  onSelect,
  onUpdate,
}: {
  data: SitesState | undefined;
  loading: boolean;
  error: unknown;
  selectedSlug: string | null;
  onSelect: (site: HostedSite) => void;
  onUpdate: (site: HostedSite) => void;
}) {
  const { openHere } = useOpenApp();
  const [query, setQuery] = useState("");
  const sites = (data?.sites ?? []).filter((site) => matchesSite(site, query));
  const usage =
    data && data.limitBytes > 0
      ? `${formatBytes(data.usedBytes)} of ${formatBytes(data.limitBytes)} · in your plan`
      : data && data.usedBytes > 0
        ? formatBytes(data.usedBytes)
        : null;

  return (
    <div className="flex flex-col gap-2" data-testid="my-uno-sites">
      <div className="flex items-center gap-1.5">
        <SearchBox
          value={query}
          onChange={setQuery}
          placeholder="Name or address"
          className="ml-auto w-44 sm:w-52"
        />
        <Button
          size="sm"
          variant="outline"
          // Web lite has no Files to publish from: the console publishes.
          render={
            isWebLite ? (
              <a href={consoleLinks.sites} target="_blank" rel="noreferrer" />
            ) : (
              <Link to="/files" />
            )
          }
        >
          <UploadIcon />
          Publish a site
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2 pt-2">
          <Skeleton className="h-11 w-full rounded-xl" />
          <Skeleton className="h-11 w-full rounded-xl" />
        </div>
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
        <>
          <GroupTitle right={usage}>On Uno Hosting</GroupTitle>
          {sites.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Nothing matches.</p>
          ) : (
            <RowList>
              {sites.map((site) => (
                <Row
                  key={site.slug}
                  selected={selectedSlug === site.slug}
                  onSelect={() => onSelect(site)}
                  label={site.slug}
                  testId="my-uno-site"
                  action={
                    <span className={`flex items-center gap-0.5 ${HOVER_ONLY}`}>
                      <SiteCopyButton site={site} />
                      <Button size="xs" variant="ghost" onClick={() => onUpdate(site)}>
                        <UploadIcon />
                        Update
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => openHere({ url: site.url, name: site.slug })}
                      >
                        Open
                      </Button>
                    </span>
                  }
                >
                  <GlobeIcon className="size-4 shrink-0 text-orange-500" />
                  <span className="flex w-36 shrink-0 items-center gap-1 font-medium sm:w-44">
                    <span className="truncate">{site.slug}</span>
                    {site.hasPassword ? (
                      <LockIcon
                        className="size-3 shrink-0 text-muted-foreground"
                        aria-label="Password protected"
                      />
                    ) : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {siteHost(site)}
                  </span>
                  <span className="hidden w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:block">
                    {formatBytes(site.sizeBytes)}
                  </span>
                  <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block">
                    {site.updatedAt ? formatElapsedAgoLabel(site.updatedAt) : ""}
                  </span>
                </Row>
              ))}
            </RowList>
          )}
        </>
      )}
    </div>
  );
}
