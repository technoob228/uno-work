/**
 * Workspace vision (Misha 10.11, demo/workspace-vision-1110): the interface
 * belongs to the workspace — chats, assistants, apps and memory live in the
 * account's cloud; computers, Spark, data and addresses are the hardware of
 * one "liquid computer". A demo, not a release: on only in the demo build
 * (`VITE_DEMO=assist`) unless `?ws=off` (today's Work, to compare). Kept in
 * this browser: the password page drops the address.
 */
import { DEMO_ASSIST } from "../demo/demoFlag";

const KEY = "demo:ws";

function read(): boolean {
  if (!DEMO_ASSIST || typeof window === "undefined") return false;
  try {
    const asked = new URLSearchParams(location.search).get("ws");
    if (asked === "on" || asked === "off") {
      localStorage.setItem(KEY, asked);
      return asked === "on";
    }
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

/** The workspace screens instead of today's per-computer ones. */
export const WORKSPACE_VISION: boolean = read();
