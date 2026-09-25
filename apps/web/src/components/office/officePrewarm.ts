/**
 * Gets the office engine into this browser before someone opens a document.
 *
 * The engine is ~110 MB of code (≈17 MB compressed). Opening the first
 * document used to download all of it right then — 30+ s on a slow link.
 * Here we:
 *   - register the engine's service worker (served by the daemon for the
 *     versioned engine path, officeEngineAssets.ts) so later opens read the
 *     engine from Cache Storage instead of the network;
 *   - fill that cache in the background, a few files at a time, when Files
 *     opens, when Office opens, and a little after the app starts for people
 *     who have used Office in this browser before.
 *
 * Nothing here is required for Office to work: every step fails quietly and
 * the editor then loads the old way.
 */
import type { OfficeDocumentType } from "./officeFormats";
import { OFFICE_ENGINE_API_PATH, officeEngineBase, probeOfficeEngine } from "./officeEngine";

/** Same name the service worker uses (officeEngineServiceWorkerSource). */
export function officeEngineCacheName(version: string): string {
  return `uno-office-engine-${version}`;
}

const COMMON_FILES = [
  OFFICE_ENGINE_API_PATH,
  "vendor/sdkjs/common/wasm/x2t/x2t.wasm",
  "vendor/sdkjs/common/wasm/x2t/x2t.js",
  "vendor/sdkjs/common/wasm/x2t/x2t_helper.js",
  "vendor/sdkjs/common/libfont/engine/fonts.wasm",
  "vendor/sdkjs/common/libfont/engine/fonts.js",
  "vendor/sdkjs/common/AllFonts.js",
  "vendor/sdkjs/common/Charts/ChartStyles.js",
  "vendor/sdkjs/common/Images/cursors/svg.json",
  "vendor/sdkjs/common/Images/fonts_thumbnail.png.bin",
  "vendor/web-apps/vendor/requirejs/require.js",
  "vendor/web-apps/vendor/socketio/socket.io.min.js",
  "vendor/web-apps/vendor/xregexp/xregexp-all-min.js",
  "vendor/themes.json",
  // The default body font almost every document asks for.
  "vendor/fonts/049",
];

const EDITOR_DIRS: Record<OfficeDocumentType, { sdk: string; app: string }> = {
  word: { sdk: "word", app: "documenteditor" },
  cell: { sdk: "cell", app: "spreadsheeteditor" },
  slide: { sdk: "slide", app: "presentationeditor" },
};

/** Engine files (relative to the engine base) one editor needs to open a document. */
export function officeEngineFilesFor(kind: OfficeDocumentType): string[] {
  const { sdk, app } = EDITOR_DIRS[kind];
  return [
    `vendor/sdkjs/${sdk}/sdk-all-min.js`,
    `vendor/sdkjs/${sdk}/sdk-all.js`,
    `vendor/web-apps/apps/${app}/main/index.html`,
    `vendor/web-apps/apps/${app}/main/app.js`,
    `vendor/web-apps/apps/${app}/main/code.js`,
    `vendor/web-apps/apps/${app}/main/resources/css/app.css`,
    `vendor/web-apps/apps/${app}/main/locale/en.json`,
    ...(kind === "cell" ? [`vendor/sdkjs/cell/css/main.css`] : []),
  ];
}

const USED_KINDS_KEY = "uno.office.usedKinds";

/** Remember that this browser opened a kind of document (drives the idle prewarm). */
export function rememberOfficeKind(kind: OfficeDocumentType): void {
  try {
    const kinds = new Set(readUsedKinds());
    if (kinds.has(kind)) return;
    kinds.add(kind);
    localStorage.setItem(USED_KINDS_KEY, JSON.stringify([...kinds]));
  } catch {
    /* private mode: no memory, no idle prewarm */
  }
}

export function readUsedKinds(): OfficeDocumentType[] {
  try {
    const raw = JSON.parse(localStorage.getItem(USED_KINDS_KEY) ?? "[]") as unknown;
    return Array.isArray(raw)
      ? raw.filter((kind): kind is OfficeDocumentType => kind in EDITOR_DIRS)
      : [];
  } catch {
    return [];
  }
}

interface NetworkInformationLike {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

function onSlowOrMeteredLink(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? "");
}

function canUseServiceWorker(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    typeof caches !== "undefined"
  );
}

let registered: Promise<void> | null = null;

/** Registers the engine's service worker for this engine version (once per page). */
export function registerOfficeEngineWorker(version: string): Promise<void> {
  if (!canUseServiceWorker()) return Promise.resolve();
  registered ??= navigator.serviceWorker
    .register(`${officeEngineBase(version)}vendor/document_editor_service_worker.js`, {
      scope: `${officeEngineBase(version)}vendor/`,
    })
    .then(() => undefined)
    .catch(() => undefined);
  return registered;
}

const warmed = new Map<string, Promise<void>>();

/**
 * Puts the files a kind of document needs into the engine's cache. Runs at
 * most once per kind and engine version per page; two downloads at a time,
 * low fetch priority. Resolves when done (or skipped); never rejects.
 */
export function prewarmOfficeEngine(
  kinds: ReadonlyArray<OfficeDocumentType>,
  options: { readonly force?: boolean } = {},
): Promise<void> {
  if (!canUseServiceWorker()) return Promise.resolve();
  if (!options.force && onSlowOrMeteredLink()) return Promise.resolve();
  return (async () => {
    const probe = await probeOfficeEngine();
    if (!probe.installed || !probe.version) return;
    const version = probe.version;
    void registerOfficeEngineWorker(version);
    const jobs: Promise<void>[] = [];
    for (const group of ["common", ...kinds] as const) {
      const key = `${version}:${group}`;
      let job = warmed.get(key);
      if (!job) {
        const files =
          group === "common" ? COMMON_FILES : officeEngineFilesFor(group as OfficeDocumentType);
        job = fillCache(version, files).catch(() => undefined);
        warmed.set(key, job);
      }
      jobs.push(job);
    }
    await Promise.all(jobs);
  })().catch(() => undefined);
}

async function fillCache(version: string, files: ReadonlyArray<string>): Promise<void> {
  const cache = await caches.open(officeEngineCacheName(version));
  const base = officeEngineBase(version);
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const url = new URL(`${base}${file}`, window.location.href).toString();
      if (await cache.match(url)) continue;
      const response = await fetch(url, {
        credentials: "same-origin",
        priority: "low",
      } as RequestInit).catch(() => null);
      if (response?.ok && response.status === 200) {
        await cache.put(url, response).catch(() => undefined);
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

let idleScheduled = false;

/**
 * A little after the app starts, when the browser is idle, refill the cache
 * for the kinds of documents this browser has opened before (after an engine
 * update the cache is empty again). Does nothing for people who never used
 * Office here.
 */
export function scheduleIdleOfficePrewarm(delayMs = 15_000): void {
  if (idleScheduled || typeof window === "undefined") return;
  idleScheduled = true;
  const kinds = readUsedKinds();
  if (kinds.length === 0) return;
  window.setTimeout(() => {
    const run = () => void prewarmOfficeEngine(kinds);
    const idle = (
      window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }
    ).requestIdleCallback;
    if (idle) idle(run, { timeout: 10_000 });
    else run();
  }, delayMs);
}
