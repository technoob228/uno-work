/**
 * Static file serving for plugin panels:
 * `GET /api/plugins/:pluginId/panel/<token>/*`.
 *
 * The panel is rendered by the app inside a sandboxed iframe **without**
 * `allow-same-origin`, and the CSP below repeats that (`sandbox allow-scripts`)
 * for anyone opening the URL directly: the document lives on an opaque origin,
 * so a plugin cannot touch the app — no DOM access, no app cookies, no storage.
 * The price is that no panel request can carry the session cookie.
 *
 * So every request — the document and all its sub-resources alike — must carry
 * a signed capability token in the path (`panelTokens.ts`), issued to the
 * authenticated app over RPC (`plugins.issuePanelUrl`). No header heuristics:
 * a request without a valid token is 401, whatever it claims to be.
 *
 * Path resolution (`panelPaths.ts`) plus a realpath check keep every read inside
 * this plugin's panel directory. Unknown plugins look exactly like bad tokens
 * (401) so ids cannot be probed; disabled plugins and plugins without a panel
 * are 404 even with a valid token.
 */
import Mime from "@effect/platform-node/Mime";
import { Clock, Effect, FileSystem, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  isInsideDirectory,
  parsePluginPanelRequestPath,
  PLUGIN_PANEL_ROUTE_PREFIX,
  resolvePluginPanelAssetPath,
  resolvePluginPanelLocation,
  splitPanelTokenFromRest,
} from "./panelPaths.ts";
import {
  isPanelTokenFresh,
  PANEL_TOKEN_LOAD_WINDOW_MS,
  PANEL_TOKEN_SESSION_MS,
} from "./panelTokens.ts";
import { isPluginActive, PluginRegistry } from "./PluginRegistry.ts";

/**
 * Panels are agent-written single-file apps: inline `<script>`/`<style>` is the
 * norm, so the CSP allows `unsafe-inline` while keeping every origin but the
 * daemon out (no external scripts, no remote fetches, no framing of others).
 * `sandbox allow-scripts` forces an opaque origin even when the URL is opened
 * outside the app's sandboxed iframe (new tab, `window.open`, top navigation).
 */
const PANEL_CONTENT_SECURITY_POLICY = [
  "sandbox allow-scripts",
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

const notFound = HttpServerResponse.text("Not Found", { status: 404 });
const unauthorized = HttpServerResponse.text("Unauthorized", {
  status: 401,
  headers: { "Cache-Control": "no-store" },
});

/**
 * Разыменовывает файл и директорию плагина и проверяет, что файл физически
 * лежит внутри неё. Ошибка realPath (битый симлинк, гонка удаления) — тоже
 * отказ.
 */
const resolveRealPathInsidePlugin = (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly filePath: string;
  readonly pluginDir: string;
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const realFilePath = yield* input.fileSystem
      .realPath(input.filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const realPluginDir = yield* input.fileSystem
      .realPath(input.pluginDir)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (realFilePath === null || realPluginDir === null) return false;
    return isInsideDirectory(realFilePath, realPluginDir);
  });

const servePanelAsset = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }

  const parsed = parsePluginPanelRequestPath(url.value.pathname);
  if (parsed === null) {
    return HttpServerResponse.text("Invalid panel path", { status: 400 });
  }

  const tokenised = splitPanelTokenFromRest(parsed.rest);
  if (tokenised === null) {
    return unauthorized;
  }

  const registry = yield* PluginRegistry;
  const plugins = yield* registry.getLoadedPlugins;
  const plugin = plugins.find((candidate) => candidate.id === parsed.pluginId);
  const manifest = plugin?.manifest;
  // Без панели в манифесте токен не с чем сверить — ответ тот же, что на
  // поддельный токен, чтобы id плагинов нельзя было перебирать.
  if (plugin === undefined || manifest?.panel === undefined) {
    return unauthorized;
  }
  const issuedAtMs = yield* registry.verifyPanelToken({
    pluginId: plugin.id,
    panelPath: manifest.panel.path,
    token: tokenised.token,
  });
  if (issuedAtMs === null) {
    return unauthorized;
  }
  if (!isPluginActive(plugin) || plugin.directoryPath === undefined) {
    return notFound;
  }

  const location = resolvePluginPanelLocation({
    pluginDir: plugin.directoryPath,
    panelPath: manifest.panel.path,
  });
  if (location === null) {
    return notFound;
  }

  const filePath = resolvePluginPanelAssetPath({
    location,
    pluginDir: plugin.directoryPath,
    rest: tokenised.rest,
  });
  if (filePath === null) {
    return HttpServerResponse.text("Invalid panel path", { status: 400 });
  }

  // Документ панели грузится сразу после выдачи ссылки; остальные файлы
  // (скрипты, data.json, который панель перечитывает) — пока вкладка открыта.
  const nowMs = yield* Clock.currentTimeMillis;
  const maxAgeMs =
    filePath === location.entryFilePath ? PANEL_TOKEN_LOAD_WINDOW_MS : PANEL_TOKEN_SESSION_MS;
  if (!isPanelTokenFresh({ issuedAtMs, nowMs, maxAgeMs })) {
    return unauthorized;
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
    return notFound;
  }

  // Проверка путей выше — текстовая; симлинк внутри панельной папки увёл бы
  // чтение наружу. Поэтому сверяем ещё и
  // фактический путь после разыменования.
  const resolved = yield* resolveRealPathInsidePlugin({
    fileSystem,
    filePath,
    pluginDir: plugin.directoryPath,
  });
  if (!resolved) {
    return notFound;
  }

  const data = yield* fileSystem.readFile(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!data) {
    return HttpServerResponse.text("Internal Server Error", { status: 500 });
  }

  return HttpServerResponse.uint8Array(data, {
    status: 200,
    contentType: Mime.getType(filePath) ?? "application/octet-stream",
    headers: {
      // Файлы панели перегенерируются кронами плагина — кэшировать нельзя.
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": PANEL_CONTENT_SECURITY_POLICY,
    },
  });
});

/**
 * Один wildcard-роут: `/panel/` отдаёт entry-файл манифеста, `/panel/<rest>` —
 * файл рядом с ним. Бареный `/panel` без слэша отдельно не регистрируем —
 * find-my-way считает его конфликтом с wildcard-веткой.
 */
export const pluginPanelRouteLayer = HttpRouter.add(
  "GET",
  `${PLUGIN_PANEL_ROUTE_PREFIX}/:pluginId/panel/*`,
  servePanelAsset,
);
