/**
 * The agent the person picked before Uno Work opened — the landing's "Which AI
 * will you use?" (Claude Code / Codex), carried as `?agent=claude|codex`
 * through the console's `/work` and the backend's `/enter` (fishcode
 * work_proxy.go `workEnterAgent`, passed on to "/?agent=…").
 *
 * Home opens that CLI's own sign-in by itself on the first visit
 * (HomeAgentSignIn.tsx) — the link comes from Claude Code / Codex on this
 * computer, never a page of ours.
 *
 * Read once when this module loads (before the router may drop it on a
 * redirect) and removed from the address bar. Not in lite: no computer, no CLI.
 */
import type { ProviderAuthDriver } from "@t3tools/contracts";

import { parseAgentDriver } from "../components/computer/home/agentStart";
import { isWebLite } from "../lite/flag";

let arrived: ProviderAuthDriver | null = null;
if (!isWebLite && typeof window !== "undefined") {
  try {
    const url = new URL(window.location.href);
    arrived = parseAgentDriver(url.searchParams.get("agent"));
    if (url.searchParams.has("agent")) {
      url.searchParams.delete("agent");
      window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    }
  } catch {
    // no URL API: nothing arrived
  }
}

/** The agent from the entry link, if any (stays for this page load). */
export function arrivedAgent(): ProviderAuthDriver | null {
  return arrived;
}
