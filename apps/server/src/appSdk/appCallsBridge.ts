/**
 * Where the App API finds "Join my calls" (assistants/AssistantCallsService):
 * the calls service registers itself here when it starts. A holder instead
 * of a layer dependency: the App SDK and the calls service are built side by
 * side in the server's layer, and neither should need the other to start.
 * Not registered (yet) → 503 `calls_unavailable` (`calendar_unavailable` on
 * the calendar routes).
 *
 * @module appSdk/appCallsBridge
 */
import type { AppCallsCore, AppCallsReply } from "./appApiHttp.ts";

let current: AppCallsCore | null = null;

export function setAppCallsCore(core: AppCallsCore | null): void {
  current = core;
}

const unavailableAs = (code: string, message: string) => async (): Promise<AppCallsReply> => ({
  status: 503,
  body: { error: { type: code, code, message } },
});
const unavailable = unavailableAs(
  "calls_unavailable",
  "Join my calls isn't available on this computer.",
);
const calendarUnavailable = unavailableAs(
  "calendar_unavailable",
  "Calendars aren't available on this computer.",
);

/** The App API's `core.calls`: forwards to whatever is registered now. */
export const appCallsBridge: AppCallsCore = {
  link: (caller) => (current ? current.link(caller) : unavailable()),
  calendars: (caller) => (current ? current.calendars(caller) : calendarUnavailable()),
  calendar: (caller, range) => (current ? current.calendar(caller, range) : calendarUnavailable()),
  event: (caller, body) => (current ? current.event(caller, body) : unavailable()),
};
