/**
 * "A new version of Uno Work is ready · Reload" on every screen, not only in
 * a chat: the computer in use runs another Uno Work than this page
 * (staleBundle.ts decides when and what a reload does).
 */
import { HTTP_FEATURES } from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { descriptorSupportsHttpFeature } from "../environments/httpFeatureSupport";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useServerConfig } from "../rpc/serverState";
import {
  requestSelfUpdate,
  requestSelfUpdateLater,
  SELF_UPDATE_COPY,
  selfUpdateQueryKey,
  selfUpdateQueryOptions,
} from "../selfUpdate/selfUpdate";
import {
  currentStaleBundlePage,
  dismissStaleBundleNotice,
  isStaleBundleNoticeDismissed,
  resolveStaleBundleNotice,
  STALE_BUNDLE_COPY as COPY,
} from "../staleBundle";
import { cn } from "../lib/utils";
import { useStore } from "../store";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

export function StaleBundleNotice() {
  const primary = usePrimaryEnvironmentDescriptor();
  const primaryConfig = useServerConfig();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);
  const environmentId = activeEnvironmentId ?? primary?.environmentId ?? null;
  const record = useSavedEnvironmentRegistryStore((state) =>
    environmentId ? state.byId[environmentId] : undefined,
  );
  const runtime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? state.byId[environmentId] : undefined,
  );
  const [laterKey, setLaterKey] = useState<string | null>(null);
  const [updating, setUpdating] = useState<{ key: string; error: string | null } | null>(null);
  const queryClient = useQueryClient();
  const page = currentStaleBundlePage();
  const isPrimary = primary?.environmentId === environmentId;
  const descriptor = isPrimary ? primary : (runtime?.descriptor ?? null);
  // One window: an older computer that takes "This evening" (httpFeatures
  // "update-later") gets it here too — same answer, same query as the notice
  // at the composer. Nowhere else is the status asked for from here.
  const supportsLater =
    page.uiFromOrigin && descriptorSupportsHttpFeature(descriptor, HTTP_FEATURES.updateLater);
  const selfUpdate = useQuery(selfUpdateQueryOptions(environmentId, supportsLater)).data;

  if (!environmentId) return null;
  const notice = resolveStaleBundleNotice(page, {
    environmentId,
    isPrimary,
    unoBoxId: isPrimary
      ? (primary?.unoBoxId ?? null)
      : (record?.unoBoxId ?? runtime?.descriptor?.unoBoxId ?? null),
    // The primary's live config follows a self-update (the descriptor is
    // read once at load); others report through their runtime state.
    serverVersion: isPrimary
      ? (primaryConfig?.environment.serverVersion ?? primary?.serverVersion ?? null)
      : (runtime?.serverConfig?.environment.serverVersion ??
        runtime?.descriptor?.serverVersion ??
        null),
    supportsSelfUpdate: descriptorSupportsHttpFeature(descriptor, HTTP_FEATURES.selfUpdate),
  });
  if (!notice || laterKey === notice.key || isStaleBundleNoticeDismissed(notice.key)) return null;
  // The owner already said "This evening" for this computer: nothing to ask.
  if (notice.action.kind === "self-update" && supportsLater && selfUpdate?.later) return null;
  const canLater =
    notice.action.kind === "self-update" && supportsLater && selfUpdate?.laterAvailable === true;

  const label = runtime?.descriptor?.label ?? record?.label ?? primary?.label ?? "This computer";
  const action = notice.action;
  const isUpdate = action.kind === "self-update" || action.kind === "console";
  const updatingThis = updating?.key === notice.key ? updating : null;
  const run = () => {
    switch (action.kind) {
      case "open":
        window.location.assign(action.url);
        return;
      case "reload":
        window.location.reload();
        return;
      case "console":
        window.open(action.url, "_blank", "noopener,noreferrer");
        return;
      case "self-update": {
        const key = notice.key;
        setUpdating({ key, error: null });
        requestSelfUpdate(environmentId)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: selfUpdateQueryKey(environmentId) });
          })
          .catch((error: unknown) => {
            setUpdating({
              key,
              error:
                error instanceof Error && error.message
                  ? error.message
                  : "Couldn't start the update. Try again in a minute.",
            });
          });
        return;
      }
    }
  };
  const later = () => {
    dismissStaleBundleNotice(notice.key);
    setLaterKey(notice.key);
  };
  const thisEvening = () => {
    const key = notice.key;
    requestSelfUpdateLater(environmentId)
      .then((status) => {
        // The answer carries `later`: this notice goes, the quiet line shows.
        queryClient.setQueryData(selfUpdateQueryKey(environmentId), status);
      })
      .catch((error: unknown) => {
        setUpdating({
          key,
          error:
            error instanceof Error && error.message
              ? error.message
              : "Couldn't start the update. Try again in a minute.",
        });
      });
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-50 flex justify-center px-3">
      <Alert
        variant="info"
        // Three actions need a little more room for the text beside them.
        className={cn(
          "pointer-events-auto w-full bg-popover shadow-lg",
          canLater ? "max-w-xl" : "max-w-md",
        )}
        data-testid="stale-bundle-notice"
        role="status"
      >
        <RefreshCwIcon />
        <AlertTitle>
          {notice.kind === "newer" ? COPY.newerTitle : COPY.olderTitle(label, notice.serverVersion)}
        </AlertTitle>
        <AlertDescription>
          {updatingThis
            ? (updatingThis.error ?? COPY.updating(label))
            : notice.kind === "newer"
              ? COPY.newerBody(notice.serverVersion)
              : action.kind === "self-update"
                ? COPY.updateBody
                : action.kind === "console"
                  ? COPY.updateConsoleBody
                  : COPY.olderBody}
        </AlertDescription>
        <AlertAction>
          <Button size="xs" variant="ghost" onClick={later}>
            {COPY.later}
          </Button>
          {canLater ? (
            <Button
              size="xs"
              variant="outline"
              onClick={thisEvening}
              disabled={updatingThis !== null && updatingThis.error === null}
              data-testid="stale-bundle-notice-later"
            >
              {SELF_UPDATE_COPY.thisEvening}
            </Button>
          ) : null}
          <Button
            size="xs"
            onClick={run}
            disabled={updatingThis !== null && updatingThis.error === null}
            data-testid="stale-bundle-notice-action"
          >
            {canLater ? SELF_UPDATE_COPY.updateNow : isUpdate ? COPY.update : COPY.reload}
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
