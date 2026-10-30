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
  resolveMentionsMock,
} = vi.hoisted(() => {
  const openExternalMock = vi.fn(async () => undefined);
  return {
    openInPreferredEditorMock: vi.fn(async () => "vscode"),
    openUrlMock: vi.fn(),
    openFileMock: vi.fn(),
    openExternalMock,
    resolveMentionsMock: vi.fn(),
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

vi.mock("../environmentApi", () => {
  const api = { files: { resolveMentions: resolveMentionsMock } };
  return { readEnvironmentApi: () => api, ensureEnvironmentApi: () => api };
});

// Only the panel hook is faked: ChatMarkdown also imports the module's pure
// helpers (detectFileKind), which a bare mock would drop.
vi.mock("./preview/PreviewPaneContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview/PreviewPaneContext")>()),
  usePreviewPane: () => ({
    openUrl: openUrlMock,
    openFile: openFileMock,
    currentChatEnvironmentId: "env-open-chat",
    currentChatThreadId: "thread-1",
  }),
}));

import type { EnvironmentId } from "@t3tools/contracts";

import ChatMarkdown from "./ChatMarkdown";
import { usePanelFilesStore } from "./files/filesPanelTab";

/** What the computer has, by mention. */
function computerHas(files: Record<string, { path: string; kind?: "file" | "directory" }>) {
  resolveMentionsMock.mockImplementation(async ({ mentions }: { mentions: string[] }) => ({
    results: mentions.map((mention) => ({
      mention,
      path: files[mention]?.path ?? null,
      kind: files[mention] ? (files[mention].kind ?? "file") : null,
    })),
  }));
}

let environments = 0;
/** Each test its own computer: answers are kept per computer between chats. */
const freshEnvironment = () => `env-test-${(environments += 1)}` as EnvironmentId;

describe("ChatMarkdown", () => {
  afterEach(() => {
    resolveMentionsMock.mockReset();
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

  it("shows column information inline when present", async () => {
    const filePath =
      "/Users/yashsingh/p/sco/claude-code-extract/src/utils/permissions/PermissionRule.ts";
    const screen = await render(
      <ChatMarkdown text={`[PermissionRule.ts](file://${filePath}#L1C7)`} cwd="/repo/project" />,
    );

    try {
      const link = page.getByRole("link", { name: "PermissionRule.ts · L1:C7" });
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

  it("turns every way of naming a file into a chip that opens it on the chat's computer", async () => {
    const environmentId = freshEnvironment();
    computerHas({
      "~/UnoWork/report.md": { path: "/home/uno/UnoWork/report.md" },
      "/home/uno/projects/x/index.html": { path: "/home/uno/projects/x/index.html" },
      "reports/foo.md": { path: "/home/uno/projects/x/reports/foo.md" },
      "README.md": { path: "/home/uno/projects/x/README.md" },
      "app.ts": { path: "/home/uno/projects/x/src/app.ts" },
    });
    const text = [
      "Report: `~/UnoWork/report.md`, page `/home/uno/projects/x/index.html`.",
      "",
      "- plain path reports/foo.md in a list",
      "- **`README.md`** and app.ts:12",
    ].join("\n");
    const screen = await render(
      <ChatMarkdown text={text} cwd="/home/uno/projects/x" environmentId={environmentId} />,
    );

    try {
      for (const name of ["report.md", "index.html", "foo.md", "README.md", "app.ts · L12"]) {
        await expect.element(page.getByRole("link", { name })).toBeInTheDocument();
      }
      await page.getByRole("link", { name: "report.md" }).click();
      expect(openFileMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "/home/uno/UnoWork/report.md",
          path: "/home/uno/UnoWork/report.md",
          name: "report.md",
          kind: "md",
          environmentId,
        }),
      );
      expect(resolveMentionsMock).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("leaves what the computer doesn't have as it was written", async () => {
    computerHas({});
    const screen = await render(
      <ChatMarkdown
        text="Missing `not-there.md`, and `~/gone/old.md`."
        cwd="/repo"
        environmentId={freshEnvironment()}
      />,
    );

    try {
      await vi.waitFor(() => expect(resolveMentionsMock).toHaveBeenCalled());
      await expect.element(page.getByText("not-there.md")).toBeInTheDocument();
      await vi.waitFor(() =>
        expect(document.querySelectorAll('[data-testid="chat-file-chip"]')).toHaveLength(0),
      );
      await expect.element(page.getByText("~/gone/old.md")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("doesn't ask about commands, addresses, versions or code blocks", async () => {
    computerHas({});
    const text = [
      "Run `npm test` and `cat foo.md`, see https://example.com/report.md and example.com, v1.2.3, 24/7.",
      "",
      "```",
      "cat reports/in-a-block.md",
      "```",
    ].join("\n");
    const screen = await render(
      <ChatMarkdown text={text} cwd="/repo" environmentId={freshEnvironment()} />,
    );

    try {
      await expect.element(page.getByText("npm test")).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(resolveMentionsMock).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("asks once for all the answers on screen", async () => {
    const environmentId = freshEnvironment();
    computerHas({ "a.md": { path: "/repo/a.md" }, "b.md": { path: "/repo/b.md" } });
    const screen = await render(
      <>
        <ChatMarkdown text="`a.md`" cwd="/repo" environmentId={environmentId} />
        <ChatMarkdown text="`b.md` and `a.md`" cwd="/repo" environmentId={environmentId} />
      </>,
    );

    try {
      await expect.element(page.getByRole("link", { name: "b.md" })).toBeInTheDocument();
      expect(resolveMentionsMock).toHaveBeenCalledTimes(1);
      expect(resolveMentionsMock.mock.calls[0]?.[0]).toEqual({
        cwd: "/repo",
        mentions: ["a.md", "b.md"],
      });
    } finally {
      await screen.unmount();
    }
  });

  it("waits for the answer to be written before asking", async () => {
    computerHas({ "a.md": { path: "/repo/a.md" } });
    const environmentId = freshEnvironment();
    const screen = await render(
      <ChatMarkdown text="`a.md`" cwd="/repo" environmentId={environmentId} isStreaming />,
    );

    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(resolveMentionsMock).not.toHaveBeenCalled();
      await screen.rerender(
        <ChatMarkdown text="`a.md`" cwd="/repo" environmentId={environmentId} />,
      );
      await expect.element(page.getByRole("link", { name: "a.md" })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("draws a sure path before the answer comes, and a computer without the call keeps it", async () => {
    resolveMentionsMock.mockRejectedValue(new Error("unknown method"));
    const screen = await render(
      <ChatMarkdown
        text="`reports/q3.md` and `q3.md`"
        cwd="/home/uno/x"
        environmentId={freshEnvironment()}
      />,
    );

    try {
      const link = page.getByRole("link", { name: "q3.md" });
      await expect.element(link).toBeInTheDocument();
      await vi.waitFor(() => expect(resolveMentionsMock).toHaveBeenCalled());
      await link.click();
      expect(openFileMock).toHaveBeenCalledWith(
        expect.objectContaining({ path: "/home/uno/x/reports/q3.md" }),
      );
      expect(document.querySelectorAll('[data-testid="chat-file-chip"]')).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it("opens a folder in the panel's Files, at that folder", async () => {
    const environmentId = freshEnvironment();
    computerHas({ "docs/": { path: "/home/uno/x/docs", kind: "directory" } });
    const screen = await render(
      <ChatMarkdown
        text="Everything is in `docs/`."
        cwd="/home/uno/x"
        environmentId={environmentId}
      />,
    );

    try {
      await page.getByRole("link", { name: "docs" }).click();
      expect(openFileMock).toHaveBeenCalledWith(expect.objectContaining({ kind: "files" }));
      const tab = openFileMock.mock.calls[0]?.[0] as { id: string };
      expect(usePanelFilesStore.getState().byTab[tab.id]).toEqual({ path: "/home/uno/x/docs" });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a link with no file look a link", async () => {
    const screen = await render(
      <ChatMarkdown
        text="[the pricing page](/pricing)"
        cwd="/repo"
        environmentId={freshEnvironment()}
      />,
    );

    try {
      await expect
        .element(page.getByRole("link", { name: "the pricing page" }))
        .toHaveAttribute("href", "/pricing");
      expect(document.querySelectorAll('[data-testid="chat-file-chip"]')).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
