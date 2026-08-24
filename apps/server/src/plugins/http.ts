/**
 * Static file serving for plugin panels: `GET /api/plugins/:pluginId/panel/*`.
 *
 * The panel is rendered by the app inside a sandboxed iframe **without**
 * `allow-same-origin`, so the document lives on an opaque origin. That is what
 * keeps a plugin from touching the app: no DOM access, no app cookies, no
 * storage. The price is that requests the iframe makes for its own assets
 * (`data.json`, `app.js`) have a null site-for-cookies and therefore carry no
 * session cookie — they simply cannot be authenticated.
 *
 * Hence the split, deliberate and documented:
 * - navigation requests (the iframe document itself, `Sec-Fetch-Dest: iframe` /
 *   `document`, and anything without the header — curl included) require a
 *   session, exactly like attachments;
 * - subresource requests (`fetch`, `script`, `style`, `image`, …) are served
 *   without auth, but only for files inside this plugin's panel directory.
 *
 * That is acceptable because the panel's contents are no more secret than the
 * manifest itself, and path resolution (`panelPaths.ts`) makes it impossible to
 * escape the plugin directory. Disabled plugins and plugins without a panel are
 * 404 for every request, so a panel cannot be probed after being turned off.
 */
import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import {
  isPanelNavigationRequest,
  parsePluginPanelRequestPath,
  PLUGIN_PANEL_ROUTE_PREFIX,
  resolvePluginPanelAssetPath,
  resolvePluginPanelLocation,
} from "./panelPaths.ts";
import { PluginRegistry } from "./PluginRegistry.ts";

/**
 * Panels are agent-written single-file apps: inline `<script>`/`<style>` is the
 * norm, so the CSP allows `unsafe-inline` while keeping every origin but the
 * daemon out (no external scripts, no remote fetches, no framing of others).
 */
const PANEL_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
].join("; ");

const notFound = HttpServerResponse.text("Not Found", { status: 404 });

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

  if (isPanelNavigationRequest(request.headers["sec-fetch-dest"])) {
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
  }

  const registry = yield* PluginRegistry;
  const plugins = yield* registry.getLoadedPlugins;
  const plugin = plugins.find((candidate) => candidate.id === parsed.pluginId);
  const manifest = plugin?.manifest;
  if (
    plugin === undefined ||
    manifest === undefined ||
    !manifest.enabled ||
    manifest.panel === undefined ||
    plugin.directoryPath === undefined
  ) {
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
    rest: parsed.rest,
  });
  if (filePath === null) {
    return HttpServerResponse.text("Invalid panel path", { status: 400 });
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const fileInfo = yield* fileSystem.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
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
}).pipe(Effect.catchTag("AuthError", respondToAuthError));

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
