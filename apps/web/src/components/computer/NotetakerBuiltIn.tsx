/**
 * Uno Notetaker next to Uno Drive (`notetakerApp.ts` has the rules): the
 * state of its built-in tile, its one-click Add through the usual install
 * (`useAppInstalls`), and the low-memory question the store asks too.
 */
import { useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import {
  NOTETAKER_APP_ID,
  NOTETAKER_NAME,
  notetakerTileState,
  notetakerTileView,
  type NotetakerTileState,
  type NotetakerTileView,
} from "./notetakerApp";
import type { ProgramTile } from "./programModel";
import type { useAppInstalls } from "./useAppInstalls";
import type { ProgramTilesState } from "./useProgramTiles";

type AppInstalls = ReturnType<typeof useAppInstalls>;

export interface NotetakerBuiltIn {
  readonly state: NotetakerTileState;
  readonly view: NotetakerTileView;
  /** The tile's click: Add / Retry, or open it once installed. */
  readonly onClick: () => void;
  /** Its settings (⚙ / right-click) once installed; null before. */
  readonly onDetails: (() => void) | null;
  /** The low-memory question, when the tile asked to add it. */
  readonly confirm: {
    readonly message: string;
    readonly busy: boolean;
    readonly onInstallAnyway: () => void;
    readonly onCancel: () => void;
  } | null;
}

export function useNotetakerApp(input: {
  readonly installs: AppInstalls;
  readonly tiles: ReadonlyArray<ProgramTile>;
  readonly computer: ProgramTilesState["computer"];
  /** An installed app's click: its one primary action, as on any tile. */
  readonly onOpen: (tile: ProgramTile) => void;
  readonly onDetails: (tile: ProgramTile) => void;
}): NotetakerBuiltIn {
  const { installs } = input;
  // The store's own confirm and error stay in the store; the tile shows only its own.
  const [asked, setAsked] = useState(false);
  const state = notetakerTileState({
    ...input.computer,
    tiles: input.tiles,
    installs: installs.installs,
    starting: installs.starting,
    confirm: asked ? installs.confirm : null,
    startError: asked ? installs.startError : null,
    asked,
  });
  const template =
    state.kind === "add" || state.kind === "confirm" || state.kind === "failed"
      ? state.template
      : null;
  const add = (allowLowMemory = false) => {
    if (!template) return;
    setAsked(true);
    void installs.install(template, undefined, allowLowMemory ? { allowLowMemory } : undefined);
  };
  return {
    state,
    view: notetakerTileView(state),
    onClick: () => {
      if (state.kind === "installed") input.onOpen(state.tile);
      else if (state.kind === "add" || state.kind === "failed") add();
    },
    onDetails: state.kind === "installed" ? () => input.onDetails(state.tile) : null,
    confirm:
      state.kind === "confirm"
        ? {
            message: state.message,
            busy: installs.starting === NOTETAKER_APP_ID,
            onInstallAnyway: () => add(true),
            onCancel: () => {
              installs.clearConfirm();
              setAsked(false);
            },
          }
        : null,
  };
}

/** "This app needs more memory" — the same question and buttons as in the App Store. */
export function NotetakerConfirmDialog({ notetaker }: { notetaker: NotetakerBuiltIn | null }) {
  const confirm = notetaker?.confirm ?? null;
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(open) => {
        if (!open) confirm?.onCancel();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add {NOTETAKER_NAME}?</DialogTitle>
          <DialogDescription>It joins your calls and writes the notes.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p
            className="rounded-xl bg-warning/10 px-3 py-3 text-xs leading-relaxed"
            role="alertdialog"
            aria-label="Not enough memory"
          >
            {confirm?.message}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => confirm?.onCancel()}>
            Cancel
          </Button>
          <Button disabled={confirm?.busy === true} onClick={() => confirm?.onInstallAnyway()}>
            {confirm?.busy ? <Spinner className="size-3.5" /> : null}
            Install anyway
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
