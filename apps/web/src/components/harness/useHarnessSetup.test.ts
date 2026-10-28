import { describe, expect, it } from "vitest";

import { isLostJobError } from "./useHarnessSetup";

/**
 * P4 (cap walkthrough 28.10): one failed status check dropped the sign-in, and
 * Submit then had no job to send the code to — the dialog froze for 25 s.
 * Only a job the computer doesn't know any more ends the sign-in here.
 */
describe("a failed sign-in status check", () => {
  it("ends the sign-in only when the computer doesn't know the job", () => {
    expect(isLostJobError({ code: "notFound", message: "Unknown sign-in job." })).toBe(true);
    expect(isLostJobError(new Error("Unknown sign-in job."))).toBe(true);
  });

  it("is asked again for anything else (a reconnecting socket, a timeout)", () => {
    expect(isLostJobError(new Error("WebSocket is closed"))).toBe(false);
    expect(isLostJobError(new Error("Request timed out"))).toBe(false);
    expect(
      isLostJobError({ code: "invalid", message: "This sign-in is not waiting for a code." }),
    ).toBe(false);
  });
});
