/**
 * Uno Notetaker as a first-party app next to Uno Drive (Misha 29.10: "built
 * into the ecosystem as easily as Uno Drive, but not installed by itself").
 * It is an App Store app (catalog id `notetaker`) with its own tile among the
 * built-ins — the sidebar's Apps page, Home's Apps widget, the desktop grid —
 * and first among the store's Recommended. The tile adds it with one click
 * through the usual install (`useAppInstalls`), then opens it like any
 * installed app.
 *
 * Pure: which state the tile is in, and what it says.
 * Contract: reports/day_2026-10-29/notetaker-ecosystem/CONTRACT.md.
 */
import type { UnoComputerAppTemplate } from "@t3tools/contracts";

import { tileAppId, type ProgramTile } from "./programModel";
import type { AppInstall } from "./useAppInstalls";

/** The App Store template, also the app's id on the computer (`~/.uno/apps/notetaker.json`). */
export const NOTETAKER_APP_ID = "notetaker";
export const NOTETAKER_NAME = "Uno Notetaker";
/** Under the tile, like "Cloud storage" under Uno Drive. */
export const NOTETAKER_CAPTION = "Meeting notes";
/** The Apps page's line under the name, like "Your files in the cloud". */
export const NOTETAKER_HINT = "Notes from your calls";
export const NOTETAKER_TITLE =
  "Uno Notetaker — joins your calls and writes the notes: summary, decisions, tasks. Made by Uno.";

export function isNotetakerTile(tile: ProgramTile): boolean {
  return tileAppId(tile) === NOTETAKER_APP_ID;
}

export type NotetakerTileState =
  /** The computer or its apps are still being read. */
  | { readonly kind: "loading" }
  /** A Mac, or a computer without the Uno account: the store isn't here. */
  | { readonly kind: "elsewhere"; readonly hint: string }
  /** The store has no Notetaker (an older console, the catalog down). */
  | { readonly kind: "soon" }
  | { readonly kind: "asleep" }
  | { readonly kind: "add"; readonly template: UnoComputerAppTemplate }
  /** The install was asked for, no answer yet. */
  | { readonly kind: "adding" }
  /** Uno asks first: this computer has less memory than the app wants. */
  | {
      readonly kind: "confirm";
      readonly template: UnoComputerAppTemplate;
      readonly message: string;
    }
  | { readonly kind: "installing" }
  | {
      readonly kind: "failed";
      readonly template: UnoComputerAppTemplate | null;
      readonly message: string | null;
    }
  | { readonly kind: "installed"; readonly tile: ProgramTile };

export interface NotetakerTileInput {
  /** The computer's state is still being read. */
  readonly loading: boolean;
  /** The computer reaches the Uno account. */
  readonly linked: boolean;
  /** An Uno cloud computer (the store installs only there). */
  readonly hasBox: boolean;
  readonly computerOn: boolean;
  /** The store's catalog; undefined while it is read. */
  readonly templates: ReadonlyArray<UnoComputerAppTemplate> | undefined;
  readonly tiles: ReadonlyArray<ProgramTile>;
  readonly installs: ReadonlyArray<AppInstall>;
  /** The catalog id an install is being asked for right now. */
  readonly starting: string | null;
  /** Only when the tile asked: the store's own confirm / error stays the store's. */
  readonly confirm: { readonly templateId: string; readonly message: string } | null;
  readonly startError: string | null;
}

export function notetakerTileState(input: NotetakerTileInput): NotetakerTileState {
  const tile = input.tiles.find(isNotetakerTile) ?? null;
  const install =
    input.installs.findLast((candidate) => candidate.templateId === NOTETAKER_APP_ID) ?? null;
  if (install?.state === "installing" || tile?.status === "installing") {
    return { kind: "installing" };
  }
  // Already here (also one registered by hand on a Mac): it opens like any app.
  if (tile && tile.status !== "failed") return { kind: "installed", tile };
  if (input.loading) return { kind: "loading" };
  if (!input.linked) return { kind: "elsewhere", hint: "Needs your Uno account" };
  if (!input.hasBox) return { kind: "elsewhere", hint: "On Uno computers" };
  const template = input.templates?.find((t) => t.id === NOTETAKER_APP_ID) ?? null;

  // Just finished: the computer's list catches up on its next read.
  if (install?.state === "running") return { kind: "installing" };
  if (input.starting === NOTETAKER_APP_ID) return { kind: "adding" };
  if (input.confirm?.templateId === NOTETAKER_APP_ID && template) {
    return { kind: "confirm", template, message: input.confirm.message };
  }
  if (install?.state === "failed" || tile?.status === "failed" || input.startError !== null) {
    return { kind: "failed", template, message: input.startError };
  }
  if (input.templates === undefined) return { kind: "loading" };
  if (!template) return { kind: "soon" };
  if (!input.computerOn) return { kind: "asleep" };
  return { kind: "add", template };
}

/** What the tile says and does, for every surface that draws it. */
export interface NotetakerTileView {
  /** The line under the name. */
  readonly caption: string;
  /** The longer line on the Apps page ("Notes from your calls"), or the caption's news. */
  readonly hint: string;
  /** Red caption: it didn't install. */
  readonly problem: boolean;
  /** The small chip under the tile ("Add", "Installing…", "Retry"); null = none. */
  readonly chip: { readonly label: string; readonly busy: boolean } | null;
  /** Nothing a click can do now. */
  readonly disabled: boolean;
  /** The tooltip. */
  readonly title: string;
}

export function notetakerTileView(state: NotetakerTileState): NotetakerTileView {
  const view = tileView(state);
  return { ...view, hint: view.caption === NOTETAKER_CAPTION ? NOTETAKER_HINT : view.caption };
}

function tileView(state: NotetakerTileState): Omit<NotetakerTileView, "hint"> {
  const base = {
    caption: NOTETAKER_CAPTION,
    problem: false,
    chip: null,
    disabled: false,
    title: NOTETAKER_TITLE,
  };
  switch (state.kind) {
    case "loading":
      return { ...base, disabled: true };
    case "elsewhere":
      return {
        ...base,
        caption: state.hint,
        disabled: true,
        title: `${NOTETAKER_NAME} — ${state.hint}`,
      };
    case "soon":
      return { ...base, caption: "Coming soon", disabled: true };
    case "asleep":
      return {
        ...base,
        caption: "Asleep",
        disabled: true,
        title: "Your computer is asleep. Wake it up to add Uno Notetaker.",
      };
    case "add":
    case "confirm":
      return { ...base, chip: { label: "Add", busy: false }, title: `Add ${NOTETAKER_NAME}` };
    case "adding":
      return { ...base, chip: { label: "Adding…", busy: true }, disabled: true };
    case "installing":
      return { ...base, chip: { label: "Installing…", busy: true }, disabled: true };
    case "failed":
      return {
        ...base,
        caption: "Didn't install",
        problem: true,
        chip: state.template ? { label: "Retry", busy: false } : null,
        disabled: state.template === null,
        title: state.message
          ? `${NOTETAKER_NAME} didn't install: ${state.message}`
          : `Add ${NOTETAKER_NAME} again`,
      };
    case "installed":
      return { ...base, title: `Open ${NOTETAKER_NAME}` };
  }
}
