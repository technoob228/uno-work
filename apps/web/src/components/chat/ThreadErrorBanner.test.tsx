import { ORPHANED_PROVIDER_SESSION_ERROR } from "@t3tools/shared/turnErrorRetry";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("a turn cut off by a restart is one plain line, without Try again", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        error={ORPHANED_PROVIDER_SESSION_ERROR}
        onDismiss={() => undefined}
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain('data-kind="restart"');
    expect(markup).toContain("Stopped by a restart. Send a message to continue.");
    expect(markup).not.toContain("did not survive");
    // Resending the person's message would start the work over.
    expect(markup).not.toContain('data-testid="turn-error-retry"');
  });

  it("other errors keep their own text", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Claude Code process exited with code 1" />,
    );
    expect(markup).toContain("Claude Code process exited with code 1");
    expect(markup).not.toContain("Stopped by a restart");
  });
});
