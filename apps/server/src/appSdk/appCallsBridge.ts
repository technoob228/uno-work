/**
 * Where the App API finds "Join my calls" (assistants/AssistantCallsService):
 * the calls service registers itself here when it starts. A holder instead
 * of a layer dependency: the App SDK and the calls service are built side by
 * side in the server's layer, and neither should need the other to start.
 * Not registered (yet) → 503 `calls_unavailable`.
 *
 * @module appSdk/appCallsBridge
 */
import type { AppCallsCore, AppCallsReply } from "./appApiHttp.ts";

let current: AppCallsCore | null = null;

export function setAppCallsCore(core: AppCallsCore | null): void {
  current = core;
}

const unavailable = async (): Promise<AppCallsReply> => ({
  status: 503,
  body: {
    error: {
      type: "calls_unavailable",
      code: "calls_unavailable",
      message: "Join my calls isn't available on this computer.",
    },
  },
});

/** The App API's `core.calls`: forwards to whatever is registered now. */
export const appCallsBridge: AppCallsCore = {
  link: (caller) => (current ? current.link(caller) : unavailable()),
  calendar: (caller, range) => (current ? current.calendar(caller, range) : unavailable()),
  event: (caller, body) => (current ? current.event(caller, body) : unavailable()),
};
