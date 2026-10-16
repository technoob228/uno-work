/**
 * The page preload of the panel browser (w0139): runs in every page the
 * panel's <webview> shows, in the page's isolated world, before the page's
 * own scripts (main.ts gives it only to `persist:uno-browser*` webviews;
 * sandboxed, no Node). Upstream t3's PickPreload, our way:
 *
 *   - Comment: pageTools/commentLayer.ts (pick an element or an area, pins);
 *   - Debug: the page's console and network come from the main process
 *     (pageTools/pageToolsMain.ts, the DevTools protocol inside the app);
 *     this preload only passes them on, so the app gets one ordered stream;
 *   - to the app: `ipcRenderer.sendToHost` → the <webview>'s `ipc-message`;
 *     from the app: `<webview>.send(command)`.
 *
 * Nothing is exposed to the page: no contextBridge, no globals.
 */
import { ipcRenderer } from "electron";

import {
  PAGE_TOOLS_COMMAND_CHANNEL,
  PAGE_TOOLS_DEBUG_CHANNEL,
  PAGE_TOOLS_HOST_CHANNEL,
  PAGE_TOOLS_RELAY_CHANNEL,
  type PageToolsWireCommand,
  type PageToolsWireMessage,
} from "@t3tools/contracts/pageTools";

import { type CommentLayer, installCommentLayer } from "./pageTools/commentLayer.ts";

const toHost = (message: PageToolsWireMessage) => {
  try {
    ipcRenderer.sendToHost(PAGE_TOOLS_HOST_CHANNEL, message);
  } catch {
    // the host is gone
  }
};

// Now, before the page's scripts: its capture listeners come first, so a
// click in Comment mode never reaches the page. Inert until the app says.
const layer: CommentLayer = installCommentLayer(window, toHost);
let enabled = false;

// A new page: the app clears its lists; main hands over what this page
// logged so far (pageToolsRelay.ts).
toHost({ type: "ready", data: { url: location.href, title: document.title } });
ipcRenderer.send(PAGE_TOOLS_DEBUG_CHANNEL, "hello");

ipcRenderer.on(PAGE_TOOLS_RELAY_CHANNEL, (_event, message: PageToolsWireMessage) => {
  if (message && typeof message === "object" && typeof message.type === "string") toHost(message);
});

ipcRenderer.on(PAGE_TOOLS_COMMAND_CHANNEL, (_event, command: PageToolsWireCommand) => {
  if (!enabled) {
    // The app uses the tools in this tab: Debug lines may flow (main keeps it for the tab).
    enabled = true;
    ipcRenderer.send(PAGE_TOOLS_DEBUG_CHANNEL, "enable");
  }
  if (!command || typeof command !== "object") return;
  switch (command.method) {
    case "setMode":
      layer.setMode(command.arg === "comment" ? "comment" : "off");
      return;
    case "setPins":
      layer.setPins(Array.isArray(command.arg) ? command.arg : []);
      return;
    case "setPaused":
      layer.setPaused(command.arg === true);
      return;
  }
});
