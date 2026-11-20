/**
 * What the server said about Protection (GET /api/v1/security/protection),
 * in four words the page can show honestly. Security is a simple entry for
 * everyone (Misha 20.11: "without a flag"), while the server still turns
 * Protection on per account (SECURITY_PROTECTION): 404 means "not on for this
 * account yet" — the page says so instead of showing nothing.
 *
 * No React here, so it is unit-tested.
 */
import { AccountHttpError } from "../../../account/unoAccount";

export type ProtectionStatus = "loading" | "not-on" | "error" | "on";

/** The server answers 404 (NOT_ENABLED, or an older server without the route). */
export function protectionNotEnabled(error: unknown): boolean {
  return error instanceof AccountHttpError && error.status === 404;
}

export function protectionStatus(query: {
  readonly isSuccess: boolean;
  readonly isError: boolean;
  readonly error: unknown;
}): ProtectionStatus {
  if (query.isSuccess) return "on";
  if (query.isError) return protectionNotEnabled(query.error) ? "not-on" : "error";
  return "loading";
}

/** The Security row in Settings → Computer: promise only what this account has. */
export function securityRowDescription(status: ProtectionStatus): string {
  return status === "on"
    ? "Cut computers off the internet, the red button, and who got in."
    : "Who got into your computers and what is open to the internet.";
}
