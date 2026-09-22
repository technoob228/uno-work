import type { UnoComputerInstalledApp, UnoMachineApp } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildProgramTiles,
  isBrowserOnMachine,
  machineAppCaption,
  machineAppOpenUrl,
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
