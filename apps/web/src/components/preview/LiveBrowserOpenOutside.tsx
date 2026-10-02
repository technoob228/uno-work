/**
 * The header button of the computer's own browser that takes the page out to
 * this device: "Open in new tab", or "Show on the internet" first for an app
 * that answers only inside the computer (see openOutsideTarget.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { EnvironmentId } from "@t3tools/contracts";
import { ExternalLinkIcon, GlobeIcon } from "lucide-react";

import { openInNewTab } from "../../navigation/useOpenApp";
import {
  machineAppActionMutationOptions,
  machineAppsQueryOptions,
} from "../computer/computerQueries";
import { confirmShowOnInternet } from "../computer/useAppPrimaryAction";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { openOutsideTarget } from "./openOutsideTarget";

export function LiveBrowserOpenOutside({
  environmentId,
  pageUrl,
}: {
  environmentId: EnvironmentId;
  pageUrl: string;
}) {
  const queryClient = useQueryClient();
  const apps = useQuery(machineAppsQueryOptions(environmentId));
  const publish = useMutation(machineAppActionMutationOptions(environmentId, queryClient));
  const target = openOutsideTarget(
    pageUrl,
    apps.data?.apps ?? [],
    apps.data?.publishBlockedReason ?? null,
  );

  if (target.kind === "publish") {
    return (
      <Button
        size="xs"
        variant="ghost"
        disabled={publish.isPending}
        title="This app answers only inside the computer. Give it a public address to open it on any device."
        onClick={() => {
          if (!confirmShowOnInternet(target.name)) return;
          publish.mutate(
            { appId: target.appId, action: "publish" },
            {
              onSuccess: () =>
                toastManager.add({
                  type: "success",
                  title: `${target.name} is on the internet`,
                  description: "Press “Open in new tab” to open it on this device.",
                }),
              onError: (error) =>
                toastManager.add({
                  type: "error",
                  title: `${target.name} isn't on the internet`,
                  description: error instanceof Error ? error.message : String(error),
                }),
            },
          );
        }}
      >
        {publish.isPending ? <Spinner className="size-3" /> : <GlobeIcon />}
        Show on the internet
      </Button>
    );
  }
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      disabled={target.kind === "none"}
      title={target.kind === "open" ? "Open in new tab" : target.reason}
      aria-label="Open in new tab"
      onClick={() => {
        if (target.kind === "open") openInNewTab(target.url);
      }}
    >
      <ExternalLinkIcon />
    </Button>
  );
}
