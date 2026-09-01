/**
 * Path resolution for plugin panels — pure helpers shared by the registry
 * (manifest validation) and the HTTP route that serves panel assets.
 *
 * URL shape: `GET /api/plugins/<pluginId>/panel/<rest>`.
 *
 * `<rest>` is resolved relative to the *panel root* — the directory that holds
 * the manifest entry file (`dirname(panel.path)` inside the plugin directory) —
 * so relative references inside the panel HTML (`data.json`, `app.js`) resolve
 * to the files sitting next to it. An empty `<rest>` serves the entry file.
 *
 * Everything is normalized and re-checked against the plugin directory prefix:
 * a panel can never read outside its own plugin.
 */
import path from "node:path";

export const PLUGIN_PANEL_ROUTE_PREFIX = "/api/plugins";
export const PLUGIN_PANEL_ROUTE_SEGMENT = "panel";

export interface PluginPanelLocation {
  /** Absolute path of the manifest entry file. */
  readonly entryFilePath: string;
  /** Absolute path of the directory that `<rest>` is resolved against. */
  readonly rootDir: string;
}

export function isInsideDirectory(candidate: string, directory: string): boolean {
  const normalizedDirectory = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
  return candidate === directory || candidate.startsWith(normalizedDirectory);
}

/**
 * Resolves the manifest's `panel.path` inside the plugin directory.
 * Returns `null` for absolute paths, traversal (`..`), NUL bytes and empty
 * paths — the caller turns that into a manifest validation error.
 */
export function resolvePluginPanelLocation(input: {
  readonly pluginDir: string;
  readonly panelPath: string;
}): PluginPanelLocation | null {
  const rawPanelPath = input.panelPath.trim();
  if (rawPanelPath.length === 0 || rawPanelPath.includes("\0")) return null;
  if (path.isAbsolute(rawPanelPath) || /^[a-zA-Z]:[\\/]/.test(rawPanelPath)) return null;
  const normalized = path.normalize(rawPanelPath);
  if (normalized.startsWith("..") || normalized.startsWith("/") || normalized.startsWith("\\")) {
    return null;
  }

  const pluginRoot = path.resolve(input.pluginDir);
  const entryFilePath = path.resolve(pluginRoot, normalized);
  if (!isInsideDirectory(entryFilePath, pluginRoot) || entryFilePath === pluginRoot) return null;

  return { entryFilePath, rootDir: path.dirname(entryFilePath) };
}

/**
 * Resolves the wildcard part of a panel URL against the panel root.
 * `rest` is the raw (still percent-encoded) path from the URL; decoding happens
 * here so that `%2e%2e%2f` is rejected together with a plain `../`.
 */
export function resolvePluginPanelAssetPath(input: {
  readonly location: PluginPanelLocation;
  readonly pluginDir: string;
  readonly rest: string;
}): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(input.rest);
  } catch {
    return null;
  }
  // Ведущие слэши срезаем: абсолютный путь в URL («/etc/passwd») становится
  // относительным к корню панели и упрётся в проверку префикса ниже.
  const trimmed = decoded.replace(/^[/\\]+/, "");
  if (trimmed.length === 0) return input.location.entryFilePath;
  if (trimmed.includes("\0")) return null;

  const normalized = path.normalize(trimmed);
  if (normalized.startsWith("..") || normalized.startsWith("/") || normalized.startsWith("\\")) {
    return null;
  }

  const rootDir = path.resolve(input.location.rootDir);
  const pluginRoot = path.resolve(input.pluginDir);
  const filePath = path.resolve(rootDir, normalized);
  if (filePath === rootDir) return input.location.entryFilePath;
  // Двойная проверка: и корень панели, и директория плагина — если панель лежит
  // в подпапке, наружу из неё тоже нельзя.
  if (!isInsideDirectory(filePath, rootDir) || !isInsideDirectory(filePath, pluginRoot)) {
    return null;
  }
  return filePath;
}

export interface ParsedPluginPanelRequest {
  readonly pluginId: string;
  readonly rest: string;
}

/**
 * Parses `/api/plugins/<pluginId>/panel/<rest>` out of a request pathname.
 * The plugin id is percent-decoded and must be a single path segment.
 */
export function parsePluginPanelRequestPath(pathname: string): ParsedPluginPanelRequest | null {
  if (!pathname.startsWith(`${PLUGIN_PANEL_ROUTE_PREFIX}/`)) return null;
  const remainder = pathname.slice(PLUGIN_PANEL_ROUTE_PREFIX.length + 1);
  const separatorIndex = remainder.indexOf("/");
  if (separatorIndex <= 0) return null;
  const rawPluginId = remainder.slice(0, separatorIndex);
  const afterId = remainder.slice(separatorIndex + 1);
  if (
    afterId !== PLUGIN_PANEL_ROUTE_SEGMENT &&
    !afterId.startsWith(`${PLUGIN_PANEL_ROUTE_SEGMENT}/`)
  ) {
    return null;
  }
  const rest = afterId.slice(PLUGIN_PANEL_ROUTE_SEGMENT.length).replace(/^\//, "");

  let pluginId: string;
  try {
    pluginId = decodeURIComponent(rawPluginId);
  } catch {
    return null;
  }
  if (pluginId.length === 0 || pluginId.includes("/") || pluginId.includes("\\")) return null;
  if (pluginId.includes("\0") || pluginId === "." || pluginId === "..") return null;

  return { pluginId, rest };
}

/**
 * Auth split for panel assets (see `plugins/http.ts` for the rationale).
 * Navigation requests (the iframe's own document) must carry the session;
 * subresources fetched by the sandboxed panel cannot carry it at all.
 */
const NAVIGATION_FETCH_DESTINATIONS = new Set([
  "document",
  "iframe",
  "frame",
  "embed",
  "object",
  "nested-document",
]);

export function isPanelNavigationRequest(secFetchDest: string | undefined): boolean {
  if (secFetchDest === undefined || secFetchDest.trim().length === 0) return true;
  return NAVIGATION_FETCH_DESTINATIONS.has(secFetchDest.trim().toLowerCase());
}
