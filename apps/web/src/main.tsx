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
import { DEMO, DEMO_ASSIST, DEMO_LOOM } from "./demo/demoFlag";

// Demo mode (?demo=w0138): computers answered in the page from fixtures,
// plus the "what to look at" panel and the variant switcher. Loaded only with the parameter.
const DemoPanelLazy = React.lazy(() =>
  DEMO_LOOM
    ? import("./demo/loom/LoomDemoPanel")
    : // The assistants base (VITE_DEMO=assist) has its own card: the account's state and scenes.
      DEMO_ASSIST
      ? import("./demo/assist/AssistPanel")
      : import("./demo/DemoPanel"),
);
if (DEMO) {
  const { startDemo } = await import("./demo/demoBoot");
  await startDemo();
  if (DEMO_LOOM) {
    const { startLoomDemo } = await import("./demo/loom/loomDemo");
    startLoomDemo();
  }
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
