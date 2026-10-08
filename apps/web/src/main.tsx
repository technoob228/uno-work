import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "@xterm/xterm/css/xterm.css";
import "./index.css";

import { isElectron } from "./env";
import { getRouter } from "./router";
import { APP_DISPLAY_NAME } from "./branding";
import { handleUncaughtRenderError } from "./fatalRecovery";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { syncDocumentFullscreenClass } from "./lib/windowFullscreen";

const ProtoPanelLazy = React.lazy(() => import("./proto/ProtoPanel"));

// Sidebar prototype (w0115, not for merge): mock computers in the page.
const PROTO = import.meta.env.VITE_SIDEBAR_PROTO === "1";
if (PROTO) {
  const { startProto } = await import("./proto/protoBoot");
  await startProto();
}

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron || PROTO ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentWindowControlsOverlayClass();
  syncDocumentFullscreenClass();
}

document.title = APP_DISPLAY_NAME;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  // Never leave a blank page when a render error escapes every boundary.
  onUncaughtError: handleUncaughtRenderError,
}).render(
  <React.StrictMode>
    <RouterProvider router={router} />
    {PROTO ? <ProtoPanelLazy /> : null}
  </React.StrictMode>,
);
