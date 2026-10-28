/**
 * Variant C: the fake daemon's faces — a persona portrait drawn on request
 * (`/api/manager/assistant/avatar/generate`, fails in `face=fail`), and the
 * picture an assistant keeps (`/api/manager/assistant/avatar`).
 */
import type { HttpHandler } from "msw";

export function avatarHandlers(): HttpHandler[] {
  return [];
}
