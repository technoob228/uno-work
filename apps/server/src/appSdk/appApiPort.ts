/** Where the App SDK's local API listens (`UNO_WORK_APP_API_PORT`, default 3779; invalid = off). */
import { APP_SDK_DEFAULT_PORT } from "@t3tools/contracts";

export const APP_API_PORT_ENV = "UNO_WORK_APP_API_PORT";

export function resolveAppApiPort(): number | null {
  const raw = process.env[APP_API_PORT_ENV]?.trim();
  if (raw === undefined || raw === "") return APP_SDK_DEFAULT_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}
