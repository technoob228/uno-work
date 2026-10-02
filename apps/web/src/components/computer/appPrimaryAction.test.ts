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
  publishBlockedReason?: string | null;
  browserOnMachine?: boolean;
}): ProgramTile {
  const [tile] = buildProgramTiles({
    machineApps: input.machineApps ?? [],
    storeApps: input.storeApps ?? [],
    installs: [],
    browserOnMachine: input.browserOnMachine ?? false,
    computerOn: input.computerOn ?? true,
    publishBlockedReason: input.publishBlockedReason ?? null,
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

  it("offers Show on the internet for a running web port nobody can open yet", () => {
    const action = appPrimaryAction(
      tileOf({
        machineApps: [machineApp({ id: "port:3000", source: "port", port: 3000, http: true })],
      }),
    );
    expect(action).toMatchObject({ kind: "publish", machineAppId: "port:3000" });
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

  describe("an app the AI built on a cloud computer", () => {
    const web = machineApp({
      id: "manifest:orders",
      source: "manifest",
      name: "Orders",
      port: 8087,
      http: true,
      localUrl: "http://localhost:8087/",
      canStart: false,
    });

    it("offers Show on the internet, not Set up with Uno, for a web app only the computer reaches", () => {
      const action = appPrimaryAction(tileOf({ machineApps: [web] }));
      expect(action.kind).toBe("publish");
      expect(action.label).toBe("Show on the internet");
      expect(action.machineAppId).toBe("manifest:orders");
    });

    it("opens it right here when the browser runs on that machine", () => {
      const action = appPrimaryAction(tileOf({ machineApps: [web], browserOnMachine: true }));
      expect(action).toMatchObject({ kind: "open", url: "http://localhost:8087/" });
    });

    it("falls back to Uno when this machine can't show apps on the internet", () => {
      const action = appPrimaryAction(
        tileOf({ machineApps: [web], publishBlockedReason: "Only an Uno computer can…" }),
      );
      expect(action.kind).toBe("setup");
    });

    const bot = machineApp({
      id: "manifest:cafe-bot",
      source: "manifest",
      name: "Café Bot",
      port: null,
      telegramBot: {
        username: "our_cafe_bot",
        link: "https://t.me/our_cafe_bot",
        tokenReady: true,
      },
    });

    it("opens a Telegram bot in Telegram", () => {
      const tile = tileOf({ machineApps: [bot] });
      expect(tile.caption).toBe("@our_cafe_bot");
      expect(appPrimaryAction(tile)).toMatchObject({
        kind: "telegram",
        label: "Open in Telegram",
        url: "https://t.me/our_cafe_bot",
      });
    });

    it("asks for the token while the bot waits for it", () => {
      const waiting = machineApp({
        ...bot,
        telegramBot: {
          username: "our_cafe_bot",
          link: "https://t.me/our_cafe_bot",
          tokenReady: false,
        },
      });
      const tile = tileOf({ machineApps: [waiting] });
      expect(tile.caption).toBe("Waiting for token");
      const action = appPrimaryAction(tile);
      expect(action.kind).toBe("token");
      expect(action.prompt).toContain("Telegram token");
    });

    it("starts a stopped bot first", () => {
      const stopped = machineApp({ ...bot, status: "stopped", canStart: true, canStop: false });
      expect(appPrimaryAction(tileOf({ machineApps: [stopped] })).kind).toBe("start");
    });
  });
});
