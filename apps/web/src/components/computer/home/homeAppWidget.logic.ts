/**
 * Where an app's Home widget comes from (P16, 28.10). Kept free of React.
 *
 *   - `direct` — an address this browser opens itself: the app's own https
 *     address, its public one, or localhost when this browser runs on the
 *     computer (a Mac's own apps);
 *   - `port` — a web app only its cloud computer reaches: shown from the
 *     port's address (`p{PORT}--{LABEL}.uno4.work`, like "Your site"), the
 *     widget's path on the port;
 *   - `none` — nothing to show yet (stopped, no port).
 *
 * The widget's path is a path on the app's port, not on the app's own page:
 * an app registered with `path: "/widget"` and a widget at `/widget` is
 * `localhost:8471/widget`, never `/widget/widget` (the 404 in P16).
 */
import type { UnoMachineApp } from "@t3tools/contracts";

import { machineAppOpenUrl } from "../programModel";
import { appWidgetUrl } from "./homeLayout";

export type HomeWidgetSource =
  | { readonly kind: "direct"; readonly url: string }
  | { readonly kind: "port"; readonly localUrl: string }
  | { readonly kind: "none"; readonly why: "stopped" | "no-address" };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function homeWidgetSource(
  app: Pick<
    UnoMachineApp,
    "url" | "status" | "privateUrl" | "http" | "publication" | "localUrl" | "port" | "widget"
  >,
  input: {
    readonly browserOnMachine: boolean;
    /** The computer is an Uno cloud computer (port addresses can reach it). */
    readonly cloudComputer: boolean;
    readonly pageProtocol?: string;
  },
): HomeWidgetSource | null {
  const widget = app.widget;
  if (!widget) return null;
  // A cloud computer's localhost is never this device's (the desktop app's
  // own page is on 127.0.0.1 too).
  const base = machineAppOpenUrl(
    app as UnoMachineApp,
    input.browserOnMachine && !input.cloudComputer,
    input.pageProtocol,
  );
  if (base) {
    // An app on a port: the widget's path is on the port (its origin), not
    // under the page the app opens at.
    const onPort = app.port !== null && base === app.localUrl;
    const root = onPort ? originOf(base) : base;
    const url = root ? appWidgetUrl(root, widget.path) : null;
    if (url) return { kind: "direct", url };
  }
  if (app.status !== "running") return { kind: "none", why: "stopped" };
  if (input.cloudComputer && app.http && app.port !== null) {
    const localUrl = appWidgetUrl(`http://localhost:${app.port}/`, widget.path);
    if (localUrl) return { kind: "port", localUrl };
  }
  return { kind: "none", why: "no-address" };
}
