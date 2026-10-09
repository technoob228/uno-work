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
import { installPreloadErrorReload } from "./staleBundle";
import { syncDocumentWindowControlsOverlayClass } from "./lib/windowControlsOverlay";
import { syncDocumentFullscreenClass } from "./lib/windowFullscreen";
import { DEMO } from "./demo/demoFlag";

// Demo mode (?demo=heavy, icp3 09.10): computers answered in the page from
// fixtures, plus the variant switcher. Loaded only with the parameter.
const DemoPanelLazy = React.lazy(() => import("./demo/DemoPanel"));
if (DEMO) {
  const { startDemo } = await import("./demo/demoBoot");
  await startDemo();
  const { installDemoHooks } = await import("./demo/demoModel");
  installDemoHooks();
}

// A tab still on the previous bundle asks for chunks that are gone after an
// update: reload once into the current one instead of a broken screen.
installPreloadErrorReload();

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron || DEMO ? createHashHistory() : createBrowserHistory();

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
    {DEMO ? (
      <React.Suspense fallback={null}>
        <DemoPanelLazy router={router} />
      </React.Suspense>
    ) : null}
  </React.StrictMode>,
);
