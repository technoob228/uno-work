import type { UnoComputerAppTemplate } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  isNotetakerTile,
  notetakerTileState,
  notetakerTileView,
  type NotetakerTileInput,
} from "./notetakerApp";
import type { ProgramTile } from "./programModel";
import type { AppInstall } from "./useAppInstalls";

const template: UnoComputerAppTemplate = {
  id: "notetaker",
  name: "Notetaker",
  description: "Notes from your calls",
  category: "productivity",
  icon: "🎙️",
  minRamMb: 4096,
  minDiskGb: 5,
  settings: [],
  madeByUno: true,
};

const tile = (status: ProgramTile["status"]): ProgramTile => ({
  key: "store:notetaker",
  name: "Meeting notes",
  icon: null,
  iconImage: null,
  templateId: "notetaker",
  status,
  caption: "Notetaker",
  openUrl: "https://notetaker.example",
  online: false,
  machineApp: null,
  storeApp: {
    key: "service:9",
    name: "Notetaker",
    templateId: "notetaker",
    icon: null,
    state: status === "failed" ? "failed" : status === "installing" ? "installing" : "running",
    url: "https://notetaker.example",
    deploymentId: 9,
  },
  install: null,
});

const install = (state: AppInstall["state"]): AppInstall => ({
  deploymentId: 9,
  name: "Notetaker",
  icon: null,
  templateId: "notetaker",
  state,
  lines: [],
  url: null,
});

const base: NotetakerTileInput = {
  loading: false,
  linked: true,
  hasBox: true,
  computerOn: true,
  templates: [template],
  tiles: [],
  installs: [],
  starting: null,
  confirm: null,
  startError: null,
};

const kind = (patch: Partial<NotetakerTileInput>) => notetakerTileState({ ...base, ...patch }).kind;

describe("the Notetaker tile", () => {
  it("not installed: Add, through the store's template", () => {
    const state = notetakerTileState(base);
    expect(state).toEqual({ kind: "add", template });
    expect(notetakerTileView(state)).toMatchObject({
      caption: "Meeting notes",
      hint: "Notes from your calls",
      chip: { label: "Add", busy: false },
      disabled: false,
    });
  });

  it("off a cloud computer it says where it lives, like the App Store", () => {
    expect(notetakerTileState({ ...base, hasBox: false })).toEqual({
      kind: "elsewhere",
      hint: "On Uno computers",
    });
    expect(notetakerTileState({ ...base, linked: false })).toEqual({
      kind: "elsewhere",
      hint: "Needs your Uno account",
    });
    expect(notetakerTileView({ kind: "elsewhere", hint: "On Uno computers" })).toMatchObject({
      caption: "On Uno computers",
      hint: "On Uno computers",
      disabled: true,
    });
  });

  it("asking → installing → installed, then a click opens it", () => {
    expect(kind({ starting: "notetaker" })).toBe("adding");
    expect(kind({ installs: [install("installing")] })).toBe("installing");
    // Done, but the computer's list hasn't caught up yet.
    expect(kind({ installs: [install("running")] })).toBe("installing");
    expect(kind({ tiles: [tile("installing")] })).toBe("installing");
    const installed = notetakerTileState({ ...base, tiles: [tile("running")] });
    expect(installed).toMatchObject({ kind: "installed" });
    expect(notetakerTileView(installed)).toMatchObject({ chip: null, disabled: false });
    // A stopped one is still installed: its own primary action starts it.
    expect(kind({ tiles: [tile("stopped")] })).toBe("installed");
  });

  it("failed: Retry with the same template", () => {
    const state = notetakerTileState({ ...base, installs: [install("failed")] });
    expect(state).toEqual({ kind: "failed", template, message: null });
    expect(notetakerTileView(state)).toMatchObject({
      caption: "Didn't install",
      problem: true,
      chip: { label: "Retry" },
    });
    expect(kind({ tiles: [tile("failed")] })).toBe("failed");
    expect(kind({ startError: "No room" })).toBe("failed");
  });

  it("low memory: the tile's own confirm, never the store's", () => {
    expect(
      notetakerTileState({ ...base, confirm: { templateId: "notetaker", message: "small" } }),
    ).toEqual({ kind: "confirm", template, message: "small" });
    expect(kind({ confirm: { templateId: "nextcloud", message: "small" } })).toBe("add");
  });

  it("waits for the catalog, says Coming soon without one, Asleep when asleep", () => {
    expect(kind({ loading: true })).toBe("loading");
    expect(kind({ templates: undefined })).toBe("loading");
    expect(kind({ templates: [] })).toBe("soon");
    expect(kind({ computerOn: false })).toBe("asleep");
    expect(notetakerTileView({ kind: "asleep" }).disabled).toBe(true);
  });

  it("knows its tile among the computer's apps", () => {
    expect(isNotetakerTile(tile("running"))).toBe(true);
    expect(isNotetakerTile({ ...tile("running"), storeApp: null, templateId: null })).toBe(false);
  });
});
