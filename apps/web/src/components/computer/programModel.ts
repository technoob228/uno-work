/**
 * The desktop's program tiles, as data: what each tile is called, how it
 * looks, whether it runs, and what "Open" opens.
 *
 * Three sources meet here — programs the daemon found on the machine
 * (`uno.computer.machineApps`), apps installed from the App Store (control
 * plane), and installs still in progress — and one rule decides "Open":
 *
 *   an address the app declared → its public address (shown on the internet)
 *   → `localhost:<port>` only when the browser itself runs on that machine.
 *
 * With none of those, a tile opens its details, where "Show on the internet"
 * lives. Kept free of React so the rules are tested directly.
 */
import type { UnoComputerInstalledApp, UnoMachineApp } from "@t3tools/contracts";

import type { AppInstall } from "./useAppInstalls";

export type ProgramStatus = "running" | "stopped" | "installing" | "failed" | "asleep" | "unknown";

export interface ProgramTile {
  readonly key: string;
  readonly name: string;
  readonly icon: string | null;
  readonly iconImage: string | null;
  readonly status: ProgramStatus;
  /** Short line under the name. */
  readonly caption: string;
  /** What a click opens; null → the tile opens its details. */
  readonly openUrl: string | null;
  /** Reachable from the internet right now. */
  readonly online: boolean;
  readonly machineApp: UnoMachineApp | null;
  readonly storeApp: UnoComputerInstalledApp | null;
  readonly install: AppInstall | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True when this page is served from the machine it looks at (a laptop, a local stand). */
export function isBrowserOnMachine(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function machineAppOpenUrl(app: UnoMachineApp, browserOnMachine: boolean): string | null {
  if (app.url) return app.url;
  if (app.status !== "running") return null;
  if (app.publication?.url && app.http) return app.publication.url;
  if (browserOnMachine && app.localUrl) return app.localUrl;
  return null;
}

const SOURCE_WORD: Record<UnoMachineApp["source"], string> = {
  manifest: "App",
  docker: "Docker",
  systemd: "Service",
  port: "Program",
};

export function machineAppCaption(app: UnoMachineApp): string {
  if (app.status === "stopped") return "Stopped";
  if (app.publication) return "On the internet";
  if (app.url) {
    try {
      return new URL(app.url).host;
    } catch {
      return SOURCE_WORD[app.source];
    }
  }
  if (app.port !== null) return `${SOURCE_WORD[app.source]} · ${app.port}`;
  return SOURCE_WORD[app.source];
}

function storeStatus(app: UnoComputerInstalledApp, computerOn: boolean): ProgramStatus {
  if (!computerOn) return "asleep";
  return app.state === "running"
    ? "running"
    : app.state === "installing"
      ? "installing"
      : app.state === "failed"
        ? "failed"
        : "unknown";
}

/** `https://notes-work.app.uno4.dev` → `notes-work.app.uno4.dev:443` style key for matching. */
function hostKey(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return null;
  }
}

export function buildProgramTiles(input: {
  readonly machineApps: ReadonlyArray<UnoMachineApp>;
  readonly storeApps: ReadonlyArray<UnoComputerInstalledApp>;
  readonly installs: ReadonlyArray<AppInstall>;
  readonly browserOnMachine: boolean;
  readonly computerOn: boolean;
}): ProgramTile[] {
  const tiles: ProgramTile[] = [];
  const tracked = new Set(input.installs.map((i) => i.deploymentId));
  const storeHosts = new Set<string>();

  for (const install of input.installs) {
    const running = install.state === "running";
    tiles.push({
      key: `install:${install.deploymentId}`,
      name: install.name,
      icon: install.icon,
      iconImage: null,
      status: running ? (input.computerOn ? "running" : "asleep") : install.state,
      caption:
        install.state === "installing"
          ? "Installing…"
          : install.state === "failed"
            ? "Didn't install"
            : "App Store",
      openUrl: running && input.computerOn ? install.url : null,
      online: running && install.url !== null,
      machineApp: null,
      storeApp: null,
      install,
    });
    const key = hostKey(install.url);
    if (key) storeHosts.add(key);
  }

  for (const app of input.storeApps) {
    if (app.deploymentId !== null && tracked.has(app.deploymentId)) continue;
    const status = storeStatus(app, input.computerOn);
    tiles.push({
      key: app.key,
      name: app.name,
      icon: app.icon,
      iconImage: null,
      status,
      caption:
        status === "asleep" ? "Asleep" : status === "installing" ? "Installing…" : "App Store",
      openUrl: status === "running" ? app.url : null,
      online: app.url !== null,
      machineApp: null,
      storeApp: app,
      install: null,
    });
    const key = hostKey(app.url);
    if (key) storeHosts.add(key);
  }

  for (const app of input.machineApps) {
    // An App Store app is already on the desktop under its catalog name.
    const key = hostKey(app.publication?.url ?? app.url);
    if (key && storeHosts.has(key)) continue;
    tiles.push({
      key: app.id,
      name: app.name,
      icon: app.icon,
      iconImage: app.iconImage,
      status: input.computerOn ? app.status : "asleep",
      caption: machineAppCaption(app),
      openUrl: input.computerOn ? machineAppOpenUrl(app, input.browserOnMachine) : null,
      online: app.publication !== null || app.url !== null,
      machineApp: app,
      storeApp: null,
      install: null,
    });
  }

  // Registered apps first (what the person made), then by name.
  const rank = (tile: ProgramTile) =>
    tile.install ? 0 : tile.machineApp?.source === "manifest" ? 1 : tile.storeApp ? 2 : 3;
  return tiles.toSorted((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
