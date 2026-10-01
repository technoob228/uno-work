/**
 * What the console asked Uno Work to do when it opened it (besides a first
 * message — `?q=`, see useUnoAiArrivals.ts):
 *
 *   `?do=upload` — the console's /start "Upload a project": open New project →
 *                  Upload from my computer; once uploaded, Uno looks at the
 *                  project and offers to put it online (HomeStart).
 *
 * The console sends it on the hand-off URL (console lib/work/workIntent.ts:
 * …/enter?t=…&do=upload). The backend's /enter must pass `do` on to "/" the
 * way it passes `q` (fishcode work_proxy.go handleEnter); until it does the
 * parameter is dropped there and Work opens on its start screen, which has
 * the same Upload a project / drop zone.
 *
 * Read once when this module loads (before the router may drop it on a
 * redirect) and removed from the address bar. Not in lite: no computer to
 * put files on.
 */
import { isWebLite } from "../lite/flag";

export type WorkIntent = "upload";

export function parseWorkIntent(value: string | null | undefined): WorkIntent | null {
  return value === "upload" ? value : null;
}

let arrived: WorkIntent | null = null;
if (!isWebLite && typeof window !== "undefined") {
  try {
    const url = new URL(window.location.href);
    arrived = parseWorkIntent(url.searchParams.get("do"));
    if (url.searchParams.has("do")) {
      url.searchParams.delete("do");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  } catch {
    // no URL API: nothing arrived
  }
}

/** An intent arrived and hasn't been acted on yet (the welcome is skipped for it). */
export function hasWorkIntent(): boolean {
  return arrived !== null;
}

/** The intent, once. */
export function takeWorkIntent(): WorkIntent | null {
  const out = arrived;
  arrived = null;
  return out;
}

/** The first task after a project is uploaded from the start screen. */
export function uploadedProjectPrompt(name: string, folder: string): string {
  return [
    `I've just uploaded my project "${name}" to ${folder}.`,
    "Look at what's inside and tell me in two or three plain sentences what it is.",
    "Then offer to put it online: a static site goes to Uno Hosting (site_publish);",
    "anything that needs a server runs on this computer as an app and is shown on the internet.",
    "Ask me before you publish anything.",
  ].join(" ");
}
