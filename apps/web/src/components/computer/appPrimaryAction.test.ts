import type { UnoComputerInstalledApp, UnoMachineApp } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { appPrimaryAction } from "./appPrimaryAction";
import { buildProgramTiles, type ProgramTile } from "./programModel";

function machineApp(patch: Partial<UnoMachineApp> = {}): UnoMachineApp {
  return {
    id: "docker:my-bot",
    source: "docker",
    name: "my-bot",
    description: null,
    icon: null,
    iconImage: null,
    status: "running",
    port: null,
    udpPorts: [],
    http: false,
    loopbackOnly: false,
    detail: null,
    url: null,
    localUrl: null,
    publication: null,
    canStart: false,
    canStop: true,
    ...patch,
  };
}

function storeApp(patch: Partial<UnoComputerInstalledApp> = {}): UnoComputerInstalledApp {
  return {
    key: "service:1",
    name: "Nextcloud",
    templateId: "nextcloud",
    icon: "☁️",
    state: "running",
    url: "https://nextcloud-work.app.uno4.dev",
    deploymentId: 1,
    ...patch,
  };
}

function tileOf(input: {
  machineApps?: UnoMachineApp[];
  storeApps?: UnoComputerInstalledApp[];
  computerOn?: boolean;
}): ProgramTile {
  const [tile] = buildProgramTiles({
    machineApps: input.machineApps ?? [],
    storeApps: input.storeApps ?? [],
    installs: [],
    browserOnMachine: false,
    computerOn: input.computerOn ?? true,
  });
  if (!tile) throw new Error("no tile");
  return tile;
}

describe("appPrimaryAction", () => {
  it("opens an app that runs and has a web address", () => {
    const action = appPrimaryAction(tileOf({ storeApps: [storeApp()] }));
    expect(action).toMatchObject({
      kind: "open",
      label: "Open",
      disabled: false,
      url: "https://nextcloud-work.app.uno4.dev",
    });
  });

  it("starts a stopped program right here when the computer can", () => {
    const action = appPrimaryAction(
      tileOf({ machineApps: [machineApp({ status: "stopped", canStart: true, canStop: false })] }),
    );
    expect(action).toMatchObject({ kind: "start", label: "Start", machineAppId: "docker:my-bot" });
    expect(action.prompt).toBeNull();
  });

  it("asks Uno to start a stopped program the computer can't start by itself", () => {
    const action = appPrimaryAction(
      tileOf({
        machineApps: [
          machineApp({ id: "systemd:bot.service", source: "systemd", status: "stopped" }),
        ],
      }),
    );
    expect(action).toMatchObject({ kind: "start", label: "Start", machineAppId: null });
    expect(action.prompt).toContain("Start my-bot on this computer");
  });

  it("offers Fix with Uno for an app that failed, by its task name", () => {
    const action = appPrimaryAction(tileOf({ storeApps: [storeApp({ state: "failed" })] }));
    expect(action).toMatchObject({ kind: "fix", label: "Fix with Uno", disabled: false });
    expect(action.prompt).toBe(
      "Files & documents (Nextcloud) isn't working. Find out why and fix it.",
    );
  });

  it("offers Fix with Uno for an App Store app whose state is unknown", () => {
    const action = appPrimaryAction(tileOf({ storeApps: [storeApp({ state: "unknown" })] }));
    expect(action.kind).toBe("fix");
  });

  it("offers Set up with Uno for a running app with no web address (a bot, a CLI app)", () => {
    const action = appPrimaryAction(tileOf({ machineApps: [machineApp()] }));
    expect(action).toMatchObject({ kind: "setup", label: "Set up with Uno" });
    expect(action.prompt).toBe(
      "Help me set up my-bot on this computer. Ask me only what you need.",
    );
  });

  it("offers Set up with Uno for a running web port nobody can open yet", () => {
    const action = appPrimaryAction(
      tileOf({
        machineApps: [machineApp({ id: "port:3000", source: "port", port: 3000, http: true })],
      }),
    );
    expect(action.kind).toBe("setup");
  });

  it("offers Set up with Uno for a running App Store app with no address", () => {
    const action = appPrimaryAction(tileOf({ storeApps: [storeApp({ url: null })] }));
    expect(action.kind).toBe("setup");
    expect(action.prompt).toContain("Files & documents (Nextcloud)");
  });

  it("shows Installing… turned off while it installs", () => {
    const action = appPrimaryAction(tileOf({ storeApps: [storeApp({ state: "installing" })] }));
    expect(action).toMatchObject({ kind: "installing", label: "Installing…", disabled: true });
  });

  it("does nothing while the computer is asleep", () => {
    const action = appPrimaryAction(tileOf({ storeApps: [storeApp()], computerOn: false }));
    expect(action).toMatchObject({ kind: "asleep", disabled: true });
  });

  it("follows an install in progress to its end", () => {
    const base = {
      deploymentId: 5,
      name: "Vaultwarden",
      icon: null,
      templateId: "vaultwarden",
      lines: [],
    };
    const build = (install: Parameters<typeof buildProgramTiles>[0]["installs"][number]) =>
      buildProgramTiles({
        machineApps: [],
        storeApps: [],
        installs: [install],
        browserOnMachine: false,
        computerOn: true,
      })[0]!;
    expect(appPrimaryAction(build({ ...base, state: "installing", url: null })).kind).toBe(
      "installing",
    );
    expect(appPrimaryAction(build({ ...base, state: "failed", url: null })).kind).toBe("fix");
    expect(
      appPrimaryAction(build({ ...base, state: "running", url: "https://vw.app.uno4.dev" })),
    ).toMatchObject({ kind: "open", url: "https://vw.app.uno4.dev" });
  });
});
