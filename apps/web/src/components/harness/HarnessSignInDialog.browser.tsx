import "../../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { HarnessSignInPanel } from "./HarnessSignInDialog";
import type { AuthJobView } from "./useHarnessSetup";

/**
 * The Claude sign-in link (0.0.107): the OAuth address is six lines of
 * parameters, so the person gets "Open sign-in page" and "Copy link" and the
 * address itself stays folded away.
 */

const LINK =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference&code_challenge=abc&code_challenge_method=S256&state=xyz";

const job = {
  jobId: "job-1",
  driver: "claudeAgent",
  method: "oauth",
  state: "running",
  log: "",
  verificationUrl: LINK,
  needsCodeInput: true,
} as unknown as AuthJobView;

afterEach(() => vi.restoreAllMocks());

describe("Sign in with Claude: the link is a button", () => {
  it("opens the sign-in page and copies the link without showing the address", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    const copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const screen = await render(
      <HarnessSignInPanel
        driver="claudeAgent"
        job={job}
        onStart={vi.fn()}
        onSubmitCode={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    const open = screen.getByRole("button", { name: "Open sign-in page" });
    await expect.element(open).toBeVisible();
    // The address is in the page only inside the folded "Show the link".
    await expect.element(screen.getByText(LINK)).not.toBeVisible();
    await expect.element(screen.getByText("Paste the code from the browser")).toBeVisible();

    await open.click();
    expect(opened).toHaveBeenCalledWith(LINK, "_blank", "noopener,noreferrer");

    await screen.getByRole("button", { name: "Copy link" }).click();
    expect(copied).toHaveBeenCalledWith(LINK);
    await expect.element(screen.getByRole("button", { name: "Copied" })).toBeVisible();

    await screen.getByText("Show the link").click();
    await expect.element(screen.getByText(LINK)).toBeVisible();
  });
});
