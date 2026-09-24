/**
 * "Cloud storage" on My Uno: how much of the account's cloud is used (one
 * storage every computer and app sees), its buckets, and the working disk the
 * computers share — all from the account, no request per computer.
 */
import { Link } from "@tanstack/react-router";
import { CloudIcon, DatabaseIcon, FolderOpenIcon, HardDriveIcon } from "lucide-react";

import type { AccountSubscription, CloudUsage } from "../../account/accountOverview";
import { formatBytes } from "../../account/billingModel";
import { isWebLite } from "../../lite/flag";
import { Meter } from "../computer/computerUi";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { GroupTitle, RowList } from "./rowsUi";

export function cloudQuotaBytes(
  cloud: CloudUsage | undefined,
  subscription: AccountSubscription | null,
): number {
  if (cloud && cloud.quotaBytes > 0) return cloud.quotaBytes;
  const planGb = subscription?.limits?.cloudGb ?? 0;
  return planGb > 0 ? planGb * 1024 ** 3 : 0;
}

function pct(used: number, total: number): number | null {
  return total > 0 ? Math.min(100, Math.round((used / total) * 100)) : null;
}

export function CloudTab({
  cloud,
  loading,
  error,
  subscription,
}: {
  cloud: CloudUsage | undefined;
  loading: boolean;
  error: unknown;
  subscription: AccountSubscription | null;
}) {
  const quota = cloudQuotaBytes(cloud, subscription);
  const used = cloud?.usedBytes ?? 0;
  const cloudPct = pct(used, quota);
  const limits = subscription?.limits;
  const diskTotal = subscription ? (subscription.diskGbOverride ?? limits?.diskGb ?? 0) : 0;
  const diskUsed = subscription?.usage.diskGbUsed ?? 0;
  const diskPct = pct(diskUsed, diskTotal);

  return (
    <div className="flex flex-col gap-2" data-testid="my-uno-cloud">
      {loading ? (
        <Skeleton className="h-16 w-full rounded-2xl" />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border/60 bg-card/40 px-4 py-3">
          <CloudIcon className="size-4 shrink-0 text-sky-500" />
          <span className="min-w-0 flex-1 text-sm">
            {error && !cloud ? (
              <span className="text-muted-foreground">
                Couldn't read the cloud just now. Your files are fine.
              </span>
            ) : (
              <>
                <span className="font-semibold tabular-nums">{formatBytes(used)}</span>
                <span className="text-muted-foreground">
                  {quota > 0 ? ` of ${formatBytes(quota)}` : ""} in the cloud — every computer and
                  app sees it
                </span>
              </>
            )}
          </span>
          {cloudPct !== null ? <Meter value={cloudPct} className="w-28" /> : null}
          {/* Web lite has no Files: it browses a computer's disk. */}
          {isWebLite ? null : (
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/files" search={{ cloud: "1" }} />}
            >
              <FolderOpenIcon />
              Open Files
            </Button>
          )}
        </div>
      )}

      {cloud && cloud.bucketList.length > 0 ? (
        <>
          <GroupTitle>Buckets</GroupTitle>
          <RowList>
            {cloud.bucketList.map((bucket) => (
              <li
                key={bucket.name}
                className="flex h-11 items-center gap-3 border-b border-border/50 px-3 text-sm last:border-0"
              >
                <DatabaseIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-medium">{bucket.name}</span>
                <span className="w-24 text-right text-xs tabular-nums text-muted-foreground">
                  {formatBytes(bucket.usedBytes)}
                </span>
              </li>
            ))}
          </RowList>
        </>
      ) : null}

      {diskTotal > 0 ? (
        <>
          <GroupTitle>Computer disks</GroupTitle>
          <RowList>
            <li className="flex h-11 items-center gap-3 px-3 text-sm">
              <HardDriveIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="shrink-0 font-medium">Working disk</span>
              <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
                Where programs run — shared by all your computers
              </span>
              {diskPct !== null ? <Meter value={diskPct} className="w-24 sm:w-28" /> : null}
              <span className="ml-auto w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:ml-0">
                {Number.isInteger(diskUsed) ? diskUsed : diskUsed.toFixed(1)} of {diskTotal} GB
              </span>
            </li>
          </RowList>
        </>
      ) : null}
    </div>
  );
}
