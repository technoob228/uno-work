import type { AppAiApp, UnoComputerInstalledApp, UnoMachineApp } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProgramTiles,
  isBrowserOnMachine,
  machineAppCaption,
  machineAppOpenUrl,
  programRemoval,
  removalCloudFiles,
} from "./programModel";

function pub(externalPort: number, url: string) {
  return {
    forwardId: 1,
    externalPort,
    url,
    host: "h",
    state: "applied",
    forwards: [{ forwardId: 1, internalPort: 3000, externalPort, protocol: "tcp" }],
  };
}

function app(patch: Partial<UnoMachineApp>): UnoMachineApp {
  return {
    id: "port:3000",
    source: "port",
    name: "Notes",
    description: null,
    icon: null,
    iconImage: null,
    status: "running",
    port: 3000,
    udpPorts: [],
    http: true,
    loopbackOnly: false,
    detail: "node · port 3000",
    url: null,
    localUrl: "http://localhost:3000/",
    publication: null,
    canStart: false,
    canStop: true,
    ...patch,
  };
}

const store: UnoComputerInstalledApp = {
  key: "service:7",
  name: "Uptime Kuma",
  templateId: "uptime-kuma",
  icon: "📈",
  state: "running",
  url: "https://uptime-kuma-work.app.uno4.dev",
  deploymentId: 91,
};

describe("opening a program", () => {
  it("knows when the page runs on the machine itself", () => {
    expect(isBrowserOnMachine("localhost")).toBe(true);
    expect(isBrowserOnMachine("127.0.0.1")).toBe(true);
    expect(isBrowserOnMachine("my-computer.u85.uno4.me")).toBe(false);
  });

  it("prefers a declared address, then the public one, then localhost on the same machine", () => {
    expect(machineAppOpenUrl(app({ url: "https://notes.example.com/" }), false)).toBe(
      "https://notes.example.com/",
    );
    const published = app({
      publication: pub(43000, "http://h:43000/"),
    });
    expect(machineAppOpenUrl(published, false)).toBe("http://h:43000/");
    expect(machineAppOpenUrl(app({}), true)).toBe("http://localhost:3000/");
    // From a remote browser, localhost would be the viewer's own laptop.
    expect(machineAppOpenUrl(app({}), false)).toBeNull();
  });

  it("does not open a stopped app or a non-web publication", () => {
    expect(machineAppOpenUrl(app({ status: "stopped" }), true)).toBeNull();
    const vpn = app({
      http: false,
      localUrl: null,
      publication: pub(1, "http://h:1/"),
    });
    expect(machineAppOpenUrl(vpn, false)).toBeNull();
  });

  it("captions tiles in plain words", () => {
    expect(machineAppCaption(app({ status: "stopped" }))).toBe("Stopped");
    expect(machineAppCaption(app({ source: "docker", port: 51821 }))).toBe("Docker · 51821");
    expect(machineAppCaption(app({ publication: pub(2, "http://h:2/") }))).toBe("On the internet");
    expect(machineAppCaption(app({ url: "https://notes.example.com/x" }))).toBe(
      "notes.example.com",
    );
  });
});

describe("buildProgramTiles", () => {
  it("puts registered apps first and names the rest alphabetically", () => {
    const tiles = buildProgramTiles({
      machineApps: [
        app({ id: "port:9000", name: "zeta" }),
        app({ id: "manifest:notes", source: "manifest", name: "Notes" }),
        app({ id: "docker:wg-easy", source: "docker", name: "wg-easy" }),
      ],
      storeApps: [store],
      installs: [],
      browserOnMachine: false,
      computerOn: true,
    });
    expect(tiles.map((t) => t.key)).toEqual([
      "manifest:notes",
      "service:7",
      "docker:wg-easy",
      "port:9000",
    ]);
    expect(tiles[1]).toMatchObject({ openUrl: store.url, online: true, caption: "App Store" });
  });

  it("does not show an App Store app twice when discovery also sees it", () => {
    const tiles = buildProgramTiles({
      machineApps: [app({ id: "docker:kuma", url: "https://uptime-kuma-work.app.uno4.dev/" })],
      storeApps: [store],
      installs: [],
      browserOnMachine: false,
      computerOn: true,
    });
    expect(tiles.map((t) => t.key)).toEqual(["service:7"]);
  });

  it("shows an install in progress once, not again as an installed app", () => {
    const tiles = buildProgramTiles({
      machineApps: [],
      storeApps: [{ ...store, state: "installing", url: null }],
      installs: [
        {
          deploymentId: 91,
          name: "Uptime Kuma",
          icon: "📈",
          templateId: "uptime-kuma",
          state: "installing",
          lines: ["Pulling…"],
          url: null,
        },
      ],
      browserOnMachine: false,
      computerOn: true,
    });
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toMatchObject({ key: "install:91", status: "installing", openUrl: null });
  });

  it("puts everything to sleep with the computer", () => {
    const tiles = buildProgramTiles({
      machineApps: [app({})],
      storeApps: [store],
      installs: [],
      browserOnMachine: true,
      computerOn: false,
    });
    expect(tiles.every((t) => t.status === "asleep" && t.openUrl === null)).toBe(true);
  });
});

describe("App Store apps show up once (0.0.72)", () => {
  const memos: UnoComputerInstalledApp = {
    key: "service:-77",
    name: "Memos",
    templateId: "memos",
    icon: "📝",
    state: "running",
    url: "https://memos-work.app.uno4.dev",
    deploymentId: 77,
    removable: true,
    webPort: 5230,
    composeProject: "uno-memos",
  };
  const build = (machineApps: UnoMachineApp[], storeApps: UnoComputerInstalledApp[] = [memos]) =>
    buildProgramTiles({
      machineApps,
      storeApps,
      installs: [],
      browserOnMachine: false,
      computerOn: true,
    });

  it("hides the app's containers, its web port and the ports its containers publish", () => {
    const tiles = build([
      app({
        id: "docker:uno-memos-memos-1",
        source: "docker",
        name: "uno-memos-memos-1",
        port: 5231,
        composeProject: "uno-memos",
        canRemove: false,
      }),
      app({ id: "port:5230", name: "Port 5230", port: 5230 }),
      app({ id: "port:5231", name: "Memos Web", port: 5231 }),
      app({ id: "port:3000", name: "Notes" }),
    ]);
    expect(tiles.map((t) => t.name)).toEqual(["Memos", "Notes"]);
  });

  it("falls back to the uno-<template> project when the console doesn't send it", () => {
    const oldConsole: UnoComputerInstalledApp = {
      ...store,
      templateId: "vaultwarden",
      name: "Vaultwarden",
      url: "https://vw-work.app.uno4.dev",
    };
    const tiles = build(
      [
        app({
          id: "docker:vw",
          source: "docker",
          name: "vw",
          port: 8090,
          composeProject: "uno-vaultwarden",
        }),
        app({ id: "port:8090", name: "Vaultwarden Web", port: 8090 }),
      ],
      [oldConsole],
    );
    expect(tiles.map((t) => t.name)).toEqual(["Vaultwarden"]);
  });

  it("hides the desktop file an App Store app registers for itself", () => {
    const tiles = build([
      app({ id: "manifest:memos", source: "manifest", name: "Memos", port: 9999 }),
      app({ id: "manifest:notes", source: "manifest", name: "My notes", port: 4000 }),
    ]);
    expect(tiles.map((t) => t.name)).toEqual(["My notes", "Memos"]);
    expect(tiles.find((t) => t.name === "Memos")?.storeApp).not.toBeNull();
  });
});

describe("Remove", () => {
  it("is offered for App Store apps and the person's own containers only", () => {
    const tiles = buildProgramTiles({
      machineApps: [
        app({
          id: "docker:my-bot",
          source: "docker",
          name: "my-bot",
          port: 7000,
          canRemove: true,
        }),
        app({ id: "docker:uno-office", source: "docker", name: "Office", port: 7100 }),
        app({ id: "systemd:notes.service", source: "systemd", name: "notes", port: 7200 }),
        app({ id: "port:7300", name: "Something", port: 7300 }),
      ],
      storeApps: [
        { ...store, removable: true },
        {
          ...store,
          key: "service:8",
          name: "My repo",
          templateId: null,
          deploymentId: 92,
          url: null,
        },
      ],
      installs: [],
      browserOnMachine: false,
      computerOn: true,
    });
    const removal = Object.fromEntries(tiles.map((t) => [t.name, programRemoval(t)]));
    expect(removal["Uptime Kuma"]).toEqual({
      kind: "store",
      deploymentId: 91,
      name: "Uptime Kuma",
      templateId: "uptime-kuma",
    });
    expect(removal["my-bot"]).toEqual({
      kind: "container",
      appId: "docker:my-bot",
      container: "my-bot",
    });
    expect(removal["Office"]).toBeNull();
    expect(removal["notes"]).toBeNull();
    expect(removal["Something"]).toBeNull();
    expect(removal["My repo"]).toBeNull();
  });

  it("is on a just-installed app once the service list knows it", () => {
    const tiles = buildProgramTiles({
      machineApps: [],
      storeApps: [{ ...store, removable: true }],
      installs: [
        {
          deploymentId: 91,
          name: "Uptime Kuma",
          icon: "📈",
          templateId: "uptime-kuma",
          state: "running",
          lines: [],
          url: store.url,
        },
      ],
      browserOnMachine: false,
      computerOn: true,
    });
    expect(tiles).toHaveLength(1);
    expect(programRemoval(tiles[0]!)).toMatchObject({ kind: "store", deploymentId: 91 });
  });

  it("offers an App Store app's cloud folder only when this computer knows it has files", () => {
    const removal = {
      kind: "store",
      deploymentId: 77,
      name: "Notetaker",
      templateId: "notetaker",
    } as const;
    const withStorage = (usedBytes: number | null, scope: "account" | "computer") =>
      ({
        id: "notetaker",
        storage: {
          limitBytes: 5 * 1024 ** 3,
          limitSetByPerson: false,
          usedBytes,
          files: null,
          bucketId: 40,
          prefix: "notetaker/",
          scope,
        },
      }) as unknown as AppAiApp;
    expect(removalCloudFiles(removal, [withStorage(1_200_000, "account")])).toEqual({
      appId: "notetaker",
      usedBytes: 1_200_000,
      scope: "account",
    });
    // Not measured yet: still asked, without a size.
    expect(removalCloudFiles(removal, [withStorage(null, "computer")])).toMatchObject({
      usedBytes: null,
      scope: "computer",
    });
    // Nothing there, no storage, another computer's list not loaded, a container.
    expect(removalCloudFiles(removal, [withStorage(0, "account")])).toBeNull();
    expect(
      removalCloudFiles(removal, [{ id: "notetaker", storage: null } as unknown as AppAiApp]),
    ).toBeNull();
    expect(removalCloudFiles(removal, undefined)).toBeNull();
    expect(
      removalCloudFiles({ ...removal, templateId: null }, [withStorage(10, "account")]),
    ).toBeNull();
    expect(
      removalCloudFiles({ kind: "container", appId: "docker:x", container: "x" }, [
        withStorage(10, "account"),
      ]),
    ).toBeNull();
  });
});
