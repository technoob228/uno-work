/**
 * What can be done to a pull request from inside Work. Only what its host has
 * shows. Merge, close and revert always ask first; the rest is one click.
 */
import type {
  PullRequestAction,
  PullRequestDetailView,
  PullRequestMergeMethod,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { pullRequestActionsFor, pullRequestBlocker } from "./pullRequestList.logic";
import { usePullRequestAction } from "./pullRequestQueries";

const METHOD_LABELS: Record<PullRequestMergeMethod, string> = {
  squash: "Squash",
  merge: "Merge commit",
  rebase: "Rebase",
};

const ACTION_LABELS: Record<PullRequestAction, string> = {
  merge: "Merge",
  "enable-auto-merge": "Auto-merge",
  "disable-auto-merge": "Stop auto-merge",
  approve: "Approve",
  ready: "Ready for review",
  close: "Close",
  reopen: "Reopen",
  revert: "Revert",
};

const CONFIRMED = new Set<PullRequestAction>(["merge", "enable-auto-merge", "close", "revert"]);

const CONFIRM_COPY: Partial<
  Record<PullRequestAction, (detail: PullRequestDetailView) => { title: string; body: string }>
> = {
  merge: (detail) => ({
    title: `Merge #${detail.number} into ${detail.baseBranch}?`,
    body: pullRequestBlocker(detail) ?? "Everything looks ready.",
  }),
  "enable-auto-merge": (detail) => ({
    title: `Auto-merge #${detail.number}?`,
    body: `It merges into ${detail.baseBranch} once the required checks and reviews pass.`,
  }),
  close: (detail) => ({
    title: `Close #${detail.number}?`,
    body: "It stays on the service and can be reopened.",
  }),
  revert: (detail) => ({
    title: `Revert #${detail.number}?`,
    body: `Opens a new pull request that undoes it on ${detail.baseBranch}.`,
  }),
};

export function PullRequestActions(props: {
  readonly environmentId: string;
  readonly detail: PullRequestDetailView;
}) {
  const { environmentId, detail } = props;
  const action = usePullRequestAction(environmentId);
  const [confirm, setConfirm] = useState<PullRequestAction | null>(null);
  const methods = detail.capabilities.mergeMethods.filter((method) =>
    detail.mergeMethods.includes(method),
  );
  const [method, setMethod] = useState<PullRequestMergeMethod | null>(null);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const chosenMethod = method ?? methods[0];

  const available = pullRequestActionsFor(
    detail,
    detail.capabilities.actions,
    detail.autoMergeEnabled,
  );
  if (available.length === 0) return null;

  const run = (chosen: PullRequestAction) => {
    const merging = chosen === "merge" || chosen === "enable-auto-merge";
    action.mutate(
      {
        projectId: detail.projectId,
        repository: detail.repository,
        number: detail.number,
        action: chosen,
        ...(merging && chosenMethod !== undefined ? { mergeMethod: chosenMethod } : {}),
        ...(merging ? { deleteBranch } : {}),
      },
      {
        onSuccess: (result) => {
          setConfirm(null);
          const url = result.url;
          toastManager.add({
            type: "success",
            title: `${ACTION_LABELS[chosen]}: done`,
            ...(url !== null
              ? {
                  actionProps: {
                    children: "Open",
                    onClick: () => void readLocalApi()?.shell.openExternal(url),
                  },
                }
              : {}),
          });
        },
      },
    );
  };

  const ask = (chosen: PullRequestAction) => {
    if (CONFIRMED.has(chosen)) setConfirm(chosen);
    else run(chosen);
  };

  const [first, ...rest] = available;
  const copy = confirm === null ? null : (CONFIRM_COPY[confirm]?.(detail) ?? null);
  const merging = confirm === "merge" || confirm === "enable-auto-merge";

  return (
    <>
      <div className="flex shrink-0 items-center gap-1">
        {first !== undefined ? (
          <Button
            size="sm"
            variant={first === "merge" ? "default" : "outline"}
            disabled={action.isPending}
            onClick={() => ask(first)}
            data-testid={`pull-request-action-${first}`}
          >
            {ACTION_LABELS[first]}
          </Button>
        ) : null}
        {rest.length > 0 ? (
          <Menu>
            <MenuTrigger
              render={<Button size="sm" variant="outline" aria-label="More actions" />}
              data-testid="pull-request-actions-more"
            >
              <ChevronDownIcon className="size-3.5" />
            </MenuTrigger>
            <MenuPopup align="end">
              {rest.map((item) => (
                <MenuItem
                  key={item}
                  onClick={() => ask(item)}
                  data-testid={`pull-request-action-${item}`}
                >
                  {ACTION_LABELS[item]}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup data-testid="pull-request-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          {merging ? (
            <div className="flex flex-col gap-3 px-6 pb-2 text-sm">
              {methods.length > 1 ? (
                <div className="flex gap-1" role="radiogroup" aria-label="How to merge">
                  {methods.map((item) => (
                    <Button
                      key={item}
                      size="sm"
                      role="radio"
                      aria-checked={item === chosenMethod}
                      variant={item === chosenMethod ? "secondary" : "ghost"}
                      onClick={() => setMethod(item)}
                    >
                      {METHOD_LABELS[item]}
                    </Button>
                  ))}
                </div>
              ) : null}
              {detail.capabilities.deleteBranch ? (
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={deleteBranch}
                    onCheckedChange={(checked) => setDeleteBranch(Boolean(checked))}
                  />
                  Delete branch {detail.headBranch}
                </label>
              ) : null}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={confirm === "close" || confirm === "revert" ? "destructive" : "default"}
              disabled={action.isPending}
              onClick={() => confirm !== null && run(confirm)}
              data-testid="pull-request-confirm-yes"
            >
              {action.isPending ? <Spinner className="size-3.5" /> : null}
              {confirm === null ? "" : ACTION_LABELS[confirm]}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
