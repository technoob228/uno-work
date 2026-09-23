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
import type {
  AppAiApp,
  AppStorageScope,
  UnoComputerInstalledApp,
  UnoMachineApp,
} from "@t3tools/contracts";

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

/**
 * What "Remove" does for a tile, or null when the tile has no Remove:
 *
 * - `store`     — an App Store app: Uno stops it and takes it off the computer
 *                 (its data stays unless the person ticks "also delete");
 * - `container` — a docker container the person started themselves: the
 *                 daemon deletes the container, its volumes stay.
 *
 * Nothing else gets one: the computer's own programs, services, processes.
 */
export type ProgramRemoval =
  | {
      readonly kind: "store";
      readonly deploymentId: number;
      readonly name: string;
      /** The catalog id — also the app's id on this computer (`~/.uno/apps/<id>.json`). */
      readonly templateId: string | null;
    }
  | { readonly kind: "container"; readonly appId: string; readonly container: string };

export function programRemoval(tile: ProgramTile): ProgramRemoval | null {
  const store = tile.storeApp;
  if (store?.removable === true && store.deploymentId !== null && store.state !== "installing") {
    return {
      kind: "store",
      deploymentId: store.deploymentId,
      name: tile.name,
      templateId: store.templateId ?? null,
    };
  }
  const app = tile.machineApp;
  if (app?.source === "docker" && app.canRemove === true) {
    return { kind: "container", appId: app.id, container: app.id.replace(/^docker:/, "") };
  }
  return null;
}

/** An app's folder in the account's cloud, offered for deletion when the app is removed. */
export interface RemovalCloudFiles {
  readonly appId: string;
  /** Last measured size; null when not measured yet. */
  readonly usedBytes: number | null;
  /** `account` — shared with the account's other computers that have the app. */
  readonly scope: AppStorageScope;
}

/**
 * The cloud folder "Remove" may also delete: only an App Store app that
 * keeps files in the cloud through this computer (Settings → Apps knows it),
 * and only when there is something there (or it wasn't measured yet).
 */
export function removalCloudFiles(
  removal: ProgramRemoval | null,
  apps: ReadonlyArray<AppAiApp> | undefined,
): RemovalCloudFiles | null {
  if (removal?.kind !== "store" || !removal.templateId || !apps) return null;
  const storage = apps.find((app) => app.id === removal.templateId)?.storage;
  if (!storage || storage.usedBytes === 0) return null;
  return { appId: removal.templateId, usedBytes: storage.usedBytes, scope: storage.scope };
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

interface StoreFootprint {
  readonly templateIds: ReadonlySet<string>;
  readonly projects: ReadonlySet<string>;
  readonly ports: ReadonlySet<number>;
}

/**
 * What of the machine belongs to App Store apps: their compose projects (the
 * console's `compose_project`, or the `uno-<template>` convention of catalog
 * apps when an older console doesn't say), their web ports, their template ids
 * (an app may register its own `~/.uno/apps/<template>.json`).
 */
export function storeFootprint(
  storeApps: ReadonlyArray<UnoComputerInstalledApp>,
  installs: ReadonlyArray<AppInstall>,
): StoreFootprint {
  const templateIds = new Set<string>();
  const projects = new Set<string>();
  const ports = new Set<number>();
  for (const app of storeApps) {
    if (app.templateId) {
      templateIds.add(app.templateId);
      projects.add(`uno-${app.templateId}`);
    }
    if (app.composeProject) projects.add(app.composeProject);
    if (app.webPort != null) ports.add(app.webPort);
  }
  for (const install of installs) {
    if (install.state === "failed" || !install.templateId) continue;
    templateIds.add(install.templateId);
    projects.add(`uno-${install.templateId}`);
  }
  return { templateIds, projects, ports };
}

/** A program the scan found that is really an App Store app, already on the desktop. */
function belongsToStoreApp(
  app: UnoMachineApp,
  store: StoreFootprint,
  storePorts: ReadonlySet<number>,
): boolean {
  if (app.composeProject && store.projects.has(app.composeProject)) return true;
  if (app.port !== null && storePorts.has(app.port)) return true;
  if (app.source === "manifest" && store.templateIds.has(app.id.replace(/^manifest:/, ""))) {
    return true;
  }
  return false;
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
  const storeByDeployment = new Map(
    input.storeApps.flatMap((a) => (a.deploymentId !== null ? [[a.deploymentId, a] as const] : [])),
  );
  const store = storeFootprint(input.storeApps, input.installs);

  for (const install of input.installs) {
    const running = install.state === "running";
    tiles.push({
      key: `install:${install.deploymentId}`,
      name: install.name,
      icon: install.icon,
      iconImage: install.iconUrl ?? null,
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
      // Once the service list knows the install, its card (sign-in, Remove) is this tile's.
      storeApp: storeByDeployment.get(install.deploymentId) ?? null,
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
      iconImage: app.iconUrl ?? null,
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

  // Containers of an App Store app: their ports are the app's too.
  const storePorts = new Set(store.ports);
  for (const app of input.machineApps) {
    if (app.composeProject && store.projects.has(app.composeProject) && app.port !== null) {
      storePorts.add(app.port);
    }
  }

  for (const app of input.machineApps) {
    // An App Store app is already on the desktop under its catalog name.
    const key = hostKey(app.publication?.url ?? app.url);
    if (key && storeHosts.has(key)) continue;
    if (belongsToStoreApp(app, store, storePorts)) continue;
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
