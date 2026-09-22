/**
 * "Cloud storage: X of Y GB" on the This computer screen — the account's S3
 * as the computer's second disk, one click from Files.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, CloudIcon } from "lucide-react";

import { CloudUsageBar, formatQuota } from "../files/CloudBrowser";
import { cloudStateQueryOptions } from "../files/filesApi";

export function ComputerCloudStorageRow({
  environmentId,
}: {
  environmentId: EnvironmentId | null;
}) {
  const state = useQuery(cloudStateQueryOptions(environmentId)).data;
  if (!state?.available) return null;
  return (
    <Link
      to="/files"
      search={{ cloud: "1" }}
      className="flex items-center gap-3 rounded-2xl border border-border/60 bg-card/40 px-4 py-3 transition-colors hover:bg-accent/40"
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sky-500/10">
        <CloudIcon className="size-4.5 text-sky-500" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          Cloud storage: {formatQuota(state.usedBytes, state.quotaBytes)}
        </span>
        <span className="mt-1.5 block max-w-sm">
          <CloudUsageBar used={state.usedBytes} quota={state.quotaBytes} />
        </span>
      </span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        Open in Files
        <ChevronRightIcon className="size-3.5" />
      </span>
    </Link>
  );
}
