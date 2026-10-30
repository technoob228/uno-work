/**
 * The "Update Uno Work" notice: a banner above the composer (ChatView) and a
 * card in My Uno / on Home. One hook holds the state so every place shows the
 * same thing and the confirmation is asked once.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { CircleCheckIcon, DownloadIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";

import { APP_VERSION } from "../branding";
import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/spinner";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import {
  PAGE_LOADED_AT,
  dismissSelfUpdateNotice,
  isSelfUpdateNoticeDismissed,
  resolveSelfUpdateView,
  SELF_UPDATE_COPY as COPY,
  selfUpdateQueryOptions,
  type SelfUpdateView,
} from "./selfUpdate";
import { UpdateEverythingDialog } from "../updateEverything/UpdateEverythingDialog";

export interface SelfUpdateController {
  readonly view: SelfUpdateView | null;
  /** The person dismissed this exact notice ("Later", ×). */
  readonly dismissed: boolean;
  readonly askToUpdate: () => void;
  readonly dismiss: () => void;
  readonly reload: () => void;
  /** Mount once next to the notice: the confirmation dialog. */
  readonly dialog: ReactNode;
}

export function useSelfUpdate(environmentId: EnvironmentId | null): SelfUpdateController {
  const query = useQuery(selfUpdateQueryOptions(environmentId));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

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

  const dismiss = useCallback(() => {
    if (key === null) return;
    dismissSelfUpdateNotice(environmentId, key);
    setDismissedKey(key);
  }, [environmentId, key]);

  return {
    view,
    dismissed,
    askToUpdate: () => setDialogOpen(true),
    dismiss,
    reload,
    // Mounted only when open: it asks every computer what it needs.
    dialog: dialogOpen ? <UpdateEverythingDialog open onOpenChange={setDialogOpen} /> : null,
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
        description: view.canUpdate ? COPY.availableBody(view.version) : COPY.notOwner,
        actions: view.canUpdate ? (
          <Button
            size={size}
            data-testid="self-update-button"
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
        description: view.message,
        actions: view.canRetry ? (
          <Button
            size={size}
            variant="outline"
            data-testid="self-update-retry"
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
  // "Updated" and "didn't finish" can be closed here too (11.10: the card on
  // Home had no way to go, it stayed for a day). "An update is ready" keeps its
  // place: Later lives on the banner, My Uno is where the person comes back.
  const canDismiss = parts.dismissable && update.view?.kind !== "available";
  return (
    <>
      <Alert variant={parts.variant} className={cn(props.className)} data-testid="self-update-card">
        {parts.icon}
        <AlertTitle>{parts.title}</AlertTitle>
        {parts.description ? <AlertDescription>{parts.description}</AlertDescription> : null}
        {parts.actions || canDismiss ? (
          <AlertAction>
            {parts.actions}
            {canDismiss ? (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Hide the update notice"
                data-testid="self-update-card-dismiss"
                onClick={update.dismiss}
              >
                <XIcon />
              </Button>
            ) : null}
          </AlertAction>
        ) : null}
      </Alert>
      {update.dialog}
    </>
  );
}
