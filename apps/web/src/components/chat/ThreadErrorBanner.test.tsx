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

  const RAW =
    "ProviderAdapterProcessError: Provider adapter process error (opencode) for thread 644d1759-2760-4e5f: spawn opencode ENOENT\n    at Generator.next (<anonymous>)";

  it("no agent can take the chat: the same line, whatever the error says", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        placement="feed"
        agentDown
        error="Claude isn't signed in on this computer, so nothing was sent."
      />,
    );
    expect(markup).toContain('data-kind="agent-down"');
    expect(markup).not.toContain("signed in");
  });

  it("the agent stopped by itself: calm, with Try again", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner
        placement="feed"
        error="OpenCode server exited unexpectedly (0)."
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain('data-kind="agent-stopped"');
    expect(markup).toContain("The agent stopped unexpectedly. Nothing is lost.");
    expect(markup).not.toContain("exited unexpectedly");
  });

  it("the agent didn't start: a plain line and the way to a person, none of our words", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner placement="feed" error={RAW} onRetry={() => undefined} />,
    );
    expect(markup).toContain('data-kind="agent-down"');
    expect(markup).toContain("The agent didn&#x27;t start on this computer.");
    expect(markup).toContain("Write to us on Telegram");
    expect(markup).toContain("Email us");
    expect(markup).toContain('data-testid="turn-error-retry"');
    expect(markup).not.toContain("ProviderAdapter");
    expect(markup).not.toContain("644d1759");
  });

  it("says the same outside the feed", () => {
    const markup = renderToStaticMarkup(<ThreadErrorBanner error={RAW} />);
    expect(markup).toContain("Write to us on Telegram");
    expect(markup).not.toContain("ProviderAdapter");
  });

  it("other errors keep their own text", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Claude Code process exited with code 1" />,
    );
    expect(markup).toContain("Claude Code process exited with code 1");
    expect(markup).not.toContain("Stopped by a restart");
  });
});
