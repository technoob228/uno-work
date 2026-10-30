/**
 * Funnel events to the console (`POST /api/v1/funnel/events`, category
 * "funnel" in the console's logs): which goal people pick, how they connect,
 * when they get the first result and when they build something of their own.
 * Fire-and-forget: an older console (404) or no account link never breaks the
 * interface. once-per-person events are also remembered here, so a reload
 * doesn't resend them.
 */
import { accountRequest, accountTransport } from "../account/unoAccount";
import { isWebLite } from "../lite/flag";
import { isElectron } from "../env";

export type FunnelEvent =
  | "onboarding_goal_selected"
  | "connect_path"
  | "first_result"
  | "built_own"
  | "next_step_shown"
  | "next_step_clicked";

export interface FunnelDetails {
  readonly goal?: string | null;
  readonly path?: string | null;
  readonly props?: Readonly<Record<string, string | number | boolean>>;
}

const ONCE: ReadonlySet<FunnelEvent> = new Set(["first_result", "built_own", "next_step_shown"]);
const SENT_KEY = "uno:funnel:sent";

function surface(): "work" | "work_lite" | "desktop" {
  if (isWebLite) return "work_lite";
  return isElectron ? "desktop" : "work";
}

function sentOnce(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

export function funnelBody(event: FunnelEvent, details: FunnelDetails = {}) {
  return {
    event,
    surface: surface(),
    ...(details.goal ? { goal: details.goal } : {}),
    ...(details.path ? { path: details.path } : {}),
    ...(details.props ? { props: details.props } : {}),
  };
}

export function trackFunnel(event: FunnelEvent, details: FunnelDetails = {}): void {
  if (accountTransport() === "none") return;
  if (ONCE.has(event)) {
    const sent = sentOnce();
    const key = `${event}:${details.goal ?? ""}`;
    if (sent.has(key)) return;
    sent.add(key);
    try {
      localStorage.setItem(SENT_KEY, JSON.stringify([...sent]));
    } catch {
      // private mode: the console dedupes first_result / built_own itself
    }
  }
  void accountRequest("POST", "/api/v1/funnel/events", funnelBody(event, details)).catch(
    () => undefined,
  );
}

/**
 * A click on the "Bring your own" card in Add a machine: do people want to
 * connect machines we don't run? `connect_path` with path `ssh` is what the
 * console already accepts; `card` tells it from onboarding's own choice.
 */
export const BRING_YOUR_OWN_FUNNEL: FunnelDetails = {
  path: "ssh",
  props: { card: "bring_your_own", from: "add_machine" },
};

export function trackBringYourOwnClick(): void {
  trackFunnel("connect_path", BRING_YOUR_OWN_FUNNEL);
}
