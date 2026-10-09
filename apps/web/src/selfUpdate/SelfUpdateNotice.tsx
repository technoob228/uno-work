/**
 * The "Update Uno Work" notice: a banner above the composer (ChatView) and a
 * card in My Uno / on Home. One hook holds the state so every place shows the
 * same thing and the confirmation is asked once.
 */
import { type EnvironmentId, HTTP_FEATURES } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, DownloadIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { APP_VERSION } from "../branding";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { isElectron } from "../env";
import { useEnvironmentSupportsHttpFeature } from "../environments/httpFeatureSupport";
import { cn } from "../lib/utils";
import {
  PAGE_LOADED_AT,
  dismissSelfUpdateNotice,
  isSelfUpdateNoticeDismissed,
  requestSelfUpdate,
  resolveSelfUpdateView,
  SELF_UPDATE_COPY as COPY,
  selfUpdateQueryKey,
  selfUpdateQueryOptions,
  type SelfUpdateStatus,
  type SelfUpdateView,
} from "./selfUpdate";

export interface SelfUpdateController {
  readonly view: SelfUpdateView | null;
  /** The person dismissed this exact notice ("Later", ×). */
  readonly dismissed: boolean;
  readonly starting: boolean;
  readonly startError: string | null;
  readonly askToUpdate: () => void;
  readonly dismiss: () => void;
  readonly reload: () => void;
  /** Mount once next to the notice: the confirmation dialog. */
  readonly dialog: ReactNode;
}

export function useSelfUpdate(environmentId: EnvironmentId | null): SelfUpdateController {
  const queryClient = useQueryClient();
  const supported = useEnvironmentSupportsHttpFeature(environmentId, HTTP_FEATURES.selfUpdate);
  const query = useQuery(selfUpdateQueryOptions(environmentId, supported));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  /** This tab started the update: it reloads by itself when the new version is up. */
  const startedHere = useRef(false);

  const mutation = useMutation({
    mutationFn: () => {
      if (!environmentId) throw new Error("No computer to update.");
      return requestSelfUpdate(environmentId);
    },
    onMutate: () => setStartError(null),
    onSuccess: (status: SelfUpdateStatus) => {
      startedHere.current = true;
      queryClient.setQueryData(selfUpdateQueryKey(environmentId), status);
    },
    onError: (error: unknown) => {
      setStartError(
        error instanceof Error && error.message
          ? error.message
          : "Couldn't start the update. Try again in a minute.",
      );
      void queryClient.invalidateQueries({ queryKey: selfUpdateQueryKey(environmentId) });
    },
  });

  const view = useMemo(
    () =>
      resolveSelfUpdateView({
        status: query.data,
        clientVersion: APP_VERSION,
        now: Date.now(),
        pageLoadedAt: PAGE_LOADED_AT,
      }),
    [query.data],
  );
  const key = view && "key" in view ? view.key : null;
  const dismissed =
    key !== null && (dismissedKey === key || isSelfUpdateNoticeDismissed(environmentId, key));

  const reload = useCallback(() => window.location.reload(), []);
  const needsReload = view?.kind === "done" && view.needsReload && !isElectron;
  useEffect(() => {
    if (!needsReload || !startedHere.current) return;
    startedHere.current = false;
    const timer = setTimeout(reload, 1_500);
    return () => clearTimeout(timer);
  }, [needsReload, reload]);

  const dismiss = useCallback(() => {
    if (key === null) return;
    dismissSelfUpdateNotice(environmentId, key);
    setDismissedKey(key);
  }, [environmentId, key]);

  const version = view?.kind === "available" || view?.kind === "failed" ? view.version : null;
  const dialog = (
    <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{COPY.confirmTitle(version ?? "the new version")}</AlertDialogTitle>
          <AlertDialogDescription>{COPY.confirmBody}</AlertDialogDescription>
          <p className="text-muted-foreground text-sm">{COPY.confirmSafety}</p>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>{COPY.later}</AlertDialogClose>
          <Button
            data-testid="self-update-confirm"
            onClick={() => {
              setConfirmOpen(false);
              mutation.mutate();
            }}
          >
            {COPY.confirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );

  return {
    view,
    dismissed,
    starting: mutation.isPending,
    startError,
    askToUpdate: () => setConfirmOpen(true),
    dismiss,
    reload,
    dialog,
  };
}

interface NoticeParts {
  readonly variant: "info" | "success" | "warning";
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly actions: ReactNode;
  readonly dismissable: boolean;
}

/** One wording for the banner and the card. */
function noticeParts(update: SelfUpdateController, size: "xs" | "sm"): NoticeParts | null {
  const view = update.view;
  if (!view) return null;
  switch (view.kind) {
    case "available":
      return {
        variant: "info",
        icon: <DownloadIcon />,
        title: COPY.availableTitle,
        description:
          update.startError ?? (view.canUpdate ? COPY.availableBody(view.version) : COPY.notOwner),
        actions: view.canUpdate ? (
          <Button
            size={size}
            data-testid="self-update-button"
            disabled={update.starting}
            onClick={update.askToUpdate}
          >
            {COPY.update}
          </Button>
        ) : null,
        dismissable: true,
      };
    case "updating":
      return {
        variant: "info",
        icon: <Spinner />,
        title: COPY.updatingTitle(view.version),
        description: COPY.updatingBody(view.step),
        actions: null,
        dismissable: false,
      };
    case "done":
      return {
        variant: "success",
        icon: <CircleCheckIcon />,
        title: COPY.doneTitle(view.version),
        description: view.needsReload && !isElectron ? COPY.doneReload : "",
        actions:
          view.needsReload && !isElectron ? (
            <Button size={size} variant="outline" onClick={update.reload}>
              {COPY.reload}
            </Button>
          ) : null,
        dismissable: true,
      };
    case "failed":
      return {
        // Calm, not red: nothing is broken — the computer is on the version it had.
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: COPY.failedTitle,
        description: update.startError ?? view.message,
        actions: view.canRetry ? (
          <Button
            size={size}
            variant="outline"
            data-testid="self-update-retry"
            disabled={update.starting}
            onClick={update.askToUpdate}
          >
            {COPY.tryAgain}
          </Button>
        ) : null,
        dismissable: true,
      };
  }
}

/** The banner above the composer; null when there is nothing to say or it was dismissed. */
export function selfUpdateBannerItem(update: SelfUpdateController): ComposerBannerStackItem | null {
  const parts = noticeParts(update, "xs");
  if (!parts || (parts.dismissable && update.dismissed)) return null;
  const key = update.view && "key" in update.view ? update.view.key : "updating";
  return {
    id: `self-update:${key}`,
    variant: parts.variant,
    icon: parts.icon,
    title: parts.title,
    ...(parts.description ? { description: parts.description } : {}),
    ...(parts.actions ? { actions: parts.actions } : {}),
    ...(parts.dismissable
      ? { dismissLabel: "Hide the update notice", onDismiss: update.dismiss }
      : {}),
  };
}

/**
 * The same notice as a card (My Uno, Home). `persistent` keeps "an update is
 * ready" visible even after "Later" on the banner — My Uno is where the person
 * comes back to press it.
 */
export function SelfUpdateCard(props: {
  readonly environmentId: EnvironmentId | null;
  readonly persistent?: boolean;
  readonly className?: string;
}) {
  const update = useSelfUpdate(props.environmentId);
  const parts = noticeParts(update, "sm");
  if (!parts) return null;
  const keepVisible = props.persistent && update.view?.kind === "available";
  if (parts.dismissable && update.dismissed && !keepVisible) return null;
  return (
    <>
      <Alert variant={parts.variant} className={cn(props.className)} data-testid="self-update-card">
        {parts.icon}
        <AlertTitle>{parts.title}</AlertTitle>
        {parts.description ? <AlertDescription>{parts.description}</AlertDescription> : null}
        {parts.actions ? <AlertAction>{parts.actions}</AlertAction> : null}
      </Alert>
      {update.dialog}
    </>
  );
}
