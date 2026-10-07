import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const {
  openInPreferredEditorMock,
  openUrlMock,
  readLocalApiMock,
  openFileMock,
  openExternalMock,
} = vi.hoisted(() => {
  const openExternalMock = vi.fn(async () => undefined);
  return {
    openInPreferredEditorMock: vi.fn(async () => "vscode"),
    openUrlMock: vi.fn(),
    openFileMock: vi.fn(),
    openExternalMock,
    readLocalApiMock: vi.fn(() => ({
      server: { getConfig: vi.fn(async () => ({ availableEditors: ["vscode"] })) },
      shell: { openInEditor: vi.fn(async () => undefined), openExternal: openExternalMock },
    })),
  };
});

vi.mock("../editorPreferences", () => ({
  openInPreferredEditor: openInPreferredEditorMock,
}));

vi.mock("../localApi", () => ({
  ensureLocalApi: vi.fn(() => {
    throw new Error("ensureLocalApi not implemented in browser test");
  }),
  readLocalApi: readLocalApiMock,
}));

// Only the panel hook is faked: ChatMarkdown also imports the module's pure
// helpers (detectFileKind), which a bare mock would drop.
vi.mock("./preview/PreviewPaneContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview/PreviewPaneContext")>()),
  usePreviewPane: () => ({
    openUrl: openUrlMock,
    openFile: openFileMock,
  }),
}));

import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown", () => {
  afterEach(() => {
    openInPreferredEditorMock.mockClear();
    openUrlMock.mockClear();
    openFileMock.mockClear();
    openExternalMock.mockClear();
    readLocalApiMock.mockClear();
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("rewrites file uri hrefs into direct paths before rendering", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath})`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", filePath);

      await link.click();

      await vi.waitFor(() => {
        expect(openFileMock).toHaveBeenCalledWith(
          expect.objectContaining({ name: "PermissionRule.ts", path: filePath }),
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps line anchors working after rewriting file uri hrefs", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts:1](file://${filePath}#L1)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}#L1`);

      await link.click();

      await vi.waitFor(() => {
        expect(openFileMock).toHaveBeenCalledWith(
          expect.objectContaining({ name: "PermissionRule.ts", path: `${filePath}:1` }),
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", `${filePath}#L1C7`);

      await link.click();

      await vi.waitFor(() => {
        expect(openFileMock).toHaveBeenCalledWith(
          expect.objectContaining({ name: "PermissionRule.ts", path: `${filePath}:1:7` }),
        );
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disambiguates duplicate file basenames inline", async () => {
    const firstPath = "/Users/yashsingh/p/t3code/apps/web/src/components/chat/MessagesTimeline.tsx";
    const secondPath = "/Users/yashsingh/p/t3code/apps/web/src/components/MessagesTimeline.tsx";
    const screen = await render(
      <ChatMarkdown
        text={`See [MessagesTimeline.tsx](file://${firstPath}) and [MessagesTimeline.tsx](file://${secondPath}).`}
        cwd="/repo/project"
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · components/chat" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: "MessagesTimeline.tsx · src/components" }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps normal web links unchanged", async () => {
    const screen = await render(
      <ChatMarkdown text="[OpenAI](https://openai.com/docs)" cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "OpenAI" });
      await expect.element(link).toBeInTheDocument();
      await expect.element(link).toHaveAttribute("href", "https://openai.com/docs");
      await expect.element(link).toHaveAttribute("target", "_blank");
    } finally {
      await screen.unmount();
    }
  });

  it("opens the person's own site in the right panel on left click", async () => {
    const screen = await render(
      <ChatMarkdown text="[My site](https://sun-salute-yoga.uno4.me/)" cwd="/repo/project" />,
    );

    try {
      await page.getByRole("link", { name: "My site" }).click();
      await vi.waitFor(() => {
        expect(openUrlMock).toHaveBeenCalledWith("https://sun-salute-yoga.uno4.me/");
      });
    } finally {
      await screen.unmount();
    }
  });

  it("opens the console and other web links in a new tab, not the panel", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[OpenAI](https://openai.com/docs) and [entries](https://console.uno.place/sites/yoga?tab=forms)"
        cwd="/repo/project"
      />,
    );

    try {
      await page.getByRole("link", { name: "OpenAI" }).click();
      await page.getByRole("link", { name: "entries" }).click();
      await vi.waitFor(() => {
        expect(openExternalMock).toHaveBeenCalledWith("https://openai.com/docs");
        expect(openExternalMock).toHaveBeenCalledWith(
          "https://console.uno.place/sites/yoga?tab=forms",
        );
      });
      expect(openUrlMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("autolinks plain file paths outside inline code", async () => {
    const screen = await render(
      <ChatMarkdown
        text="See /repo/project/src/App.tsx:12:3 and `/repo/project/src/Hidden.tsx:4`"
        cwd="/repo/project"
      />,
    );

    try {
      const link = page.getByRole("link", { name: "App.tsx · L12:C3" });
      await expect.element(link).toBeInTheDocument();
      // A plain path is linked as written (`path:line:column`); the label carries the position.
      await expect.element(link).toHaveAttribute("href", "/repo/project/src/App.tsx:12:3");
      await expect
        .element(page.getByRole("link", { name: "Hidden.tsx · L4" }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
