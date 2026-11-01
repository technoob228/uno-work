import "../../index.css";

import type {
  EnvironmentApi,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  ImportedChatTool,
  MyComputer,
  MyComputerChatHistory,
  MyComputerImportStatus,
  MyComputerImportTool,
  ThreadComputerSource,
} from "@t3tools/contracts";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { writePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { getClientSettings } from "../../hooks/useSettings";
import { importFlow, useImportFlow } from "../../localComputer/importStore";
import { localComputer, useLocalComputer } from "../../localComputer/localComputerStore";
import { ConnectComputerDialog } from "./ConnectComputerDialog";
import { ImportedChatNote } from "./ImportedChatNote";
import { ImportProgress } from "./ImportScreens";
import { LocalComputerConnector } from "./LocalComputerConnector";

const ENVIRONMENT = "env-import" as EnvironmentId;

const laptop: MyComputer = {
  id: "7",
  name: "mikhail-mbp",
  os: "darwin",
  arch: "arm64",
  online: true,
  connectedAt: "2026-10-31T10:00:00Z",
  lastSeenAt: "2026-10-31T10:00:00Z",
  helperVersion: "0.1.0",
};

const tool = (
  id: ImportedChatTool,
  name: string,
  newChats: number,
  projects: number,
  rest: Partial<MyComputerImportTool> = {},
): MyComputerImportTool => ({
  id,
  name,
  chats: newChats,
  newChats,
  projects,
  available: true,
  unavailableReason: null,
  ...rest,
});

const idle: MyComputerImportStatus = {
  computerId: laptop.id,
  state: "idle",
  declined: false,
  tools: [],
  alsoFound: [],
  skipped: { unreadable: 0, unknownFormat: 0 },
  scanned: { done: 0, total: 0 },
  progress: { done: 0, total: 0 },
  result: null,
  importedChats: 0,
  importedProjects: 0,
  message: null,
};

const found: MyComputerImportStatus = {
  ...idle,
  state: "ready",
  tools: [
    tool("claude", "Claude Code", 120, 9),
    tool("codex", "Codex", 40, 3),
    tool("opencode", "OpenCode", 0, 0, {
      available: false,
      unavailableReason: "sqlite3 isn't installed",
    }),
  ],
  alsoFound: ["T3 Code", "Orca"],
  skipped: { unreadable: 2, unknownFormat: 1 },
};

let computer: MyComputer;
let importStatus: MyComputerImportStatus;
let afterScan: MyComputerImportStatus;

const myComputer = {
  status: vi.fn(async () => ({ enabled: true, computers: [computer] })),
  activity: vi.fn(async () => []),
  pairStatus: vi.fn(),
  importStatus: vi.fn(async (_: { computerId: string }) => importStatus),
  importScan: vi.fn(async (_: { computerId: string }) => {
    importStatus = afterScan;
    return importStatus;
  }),
  importStart: vi.fn(async (input: { computerId: string; tools: ImportedChatTool[] }) => {
    importStatus = {
      ...importStatus,
      state: "importing",
      progress: { done: 30, total: input.tools.length * 80 },
    };
    return importStatus;
  }),
  importDecline: vi.fn(async (_: { computerId: string }) => {
    importStatus = { ...importStatus, declined: true };
    return importStatus;
  }),
};

function show() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <LocalComputerConnector />
      <ConnectComputerDialog />
      <ImportProgress />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  computer = laptop;
  importStatus = idle;
  afterScan = found;
  vi.clearAllMocks();
  focusManager.setFocused(true);
  writePrimaryEnvironmentDescriptor({
    environmentId: ENVIRONMENT,
  } as unknown as ExecutionEnvironmentDescriptor);
  __setEnvironmentApiOverrideForTests(ENVIRONMENT, { myComputer } as unknown as EnvironmentApi);
  localComputer.close();
  importFlow.dismiss();
});

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  writePrimaryEnvironmentDescriptor(null);
  focusManager.setFocused(undefined);
});

/** The moment the person's computer has just connected. */
function justConnected() {
  localComputer.openConnect();
  useLocalComputer.setState({ step: "command" });
  localComputer.connected(laptop.id);
}

describe("after connecting", () => {
  it("offers what it found, and nothing moves until the person says", async () => {
    justConnected();
    await show();

    const offer = page.getByTestId("import-offer");
    await expect.element(offer).toBeVisible();
    await expect.element(page.getByTestId("import-tool-claude")).toHaveTextContent("120 chats");
    await expect.element(page.getByTestId("import-tool-claude")).toHaveTextContent("9 projects");
    await expect.element(page.getByTestId("import-tool-opencode")).toHaveTextContent("sqlite3");
    await expect
      .element(page.getByTestId("import-also-found"))
      .toHaveTextContent(
        "T3 Code and Orca run these tools, so chats in their default folders are included.",
      );
    await expect
      .element(page.getByTestId("import-skipped"))
      .toHaveTextContent("3 files couldn't be read and were skipped.");
    await expect.element(page.getByTestId("import-start")).toHaveTextContent("Import 160 chats");
    expect(myComputer.importStart).not.toHaveBeenCalled();
  });

  it("imports only what stays ticked, and shows it in the corner", async () => {
    justConnected();
    await show();

    await page.getByTestId("import-tool-codex").click();
    await expect.element(page.getByTestId("import-start")).toHaveTextContent("Import 120 chats");
    await page.getByTestId("import-start").click();

    await expect.element(page.getByTestId("import-progress")).toBeVisible();
    await expect.element(page.getByTestId("import-progress")).toHaveTextContent("30 of 80");
    expect(myComputer.importStart).toHaveBeenCalledWith({
      computerId: laptop.id,
      tools: ["claude"],
    });
    expect(useLocalComputer.getState().dialog).toBe(null);
    await expect.poll(() => getClientSettings().sidebarGroupLevels).toEqual(["project"]);

    importStatus = {
      ...importStatus,
      state: "done",
      result: { imported: 120, recent: 8, snoozed: 112, failed: 0 },
    };
    await expect
      .element(page.getByTestId("import-result"))
      .toHaveTextContent("8 from today are in the list, 112 older ones in Snoozed.");
    await expect
      .element(page.getByTestId("import-progress"))
      .toHaveTextContent("120 chats imported");
    await page.getByTestId("import-dismiss").click();
    await expect.element(page.getByTestId("import-progress")).not.toBeInTheDocument();
    expect(useImportFlow.getState().followingId).toBe(null);
  });

  it("takes no for an answer", async () => {
    justConnected();
    await show();

    await page.getByTestId("connect-finish").click();
    await expect.poll(() => myComputer.importDecline.mock.calls.length).toBe(1);
    expect(useLocalComputer.getState().dialog).toBe(null);
    expect(myComputer.importStart).not.toHaveBeenCalled();

    afterScan = { ...found, declined: true };
    justConnected();
    await expect.element(page.getByTestId("connect-done")).toBeVisible();
    await new Promise((done) => setTimeout(done, 200));
    await expect.element(page.getByTestId("import-offer")).not.toBeInTheDocument();
  });

  it("just says it's connected when there are no chats", async () => {
    afterScan = { ...idle, state: "ready" };
    justConnected();
    await show();

    await expect.element(page.getByTestId("connect-done")).toBeVisible();
    await expect.poll(() => myComputer.importScan.mock.calls.length).toBe(1);
    await expect.element(page.getByTestId("import-offer")).not.toBeInTheDocument();
    await expect.element(page.getByTestId("connect-finish")).toHaveTextContent("Done");
  });
});

describe("from the computer's card", () => {
  it("comes back to the offer after a no", async () => {
    importStatus = { ...idle, declined: true, importedChats: 12, importedProjects: 3 };
    afterScan = { ...found, declined: true };
    localComputer.openManage(laptop.id);
    await show();

    await expect
      .element(page.getByTestId("manage-import"))
      .toHaveTextContent("12 chats · 3 projects");
    await page.getByTestId("manage-import").click();
    await expect.element(page.getByTestId("import-offer")).toBeVisible();
    await expect.element(page.getByTestId("import-start")).toHaveTextContent("Import 160 chats");
  });

  it("shows the search going, then that there's nothing new", async () => {
    afterScan = { ...idle, state: "scanning", scanned: { done: 40, total: 300 } };
    localComputer.openImport(laptop.id);
    await show();

    await expect.element(page.getByTestId("import-searching")).toHaveTextContent("40 of 300");
    importStatus = { ...idle, state: "ready" };
    await expect.element(page.getByTestId("import-nothing-new")).toBeVisible();
  });

  it("can't be started while the computer is off", async () => {
    computer = { ...laptop, online: false };
    localComputer.openManage(laptop.id);
    await show();

    await expect.element(page.getByTestId("manage-import")).toBeDisabled();
    await expect.element(page.getByTestId("manage-import")).toHaveTextContent("Turn it on");
  });

  it("says why the search failed", async () => {
    afterScan = { ...idle, state: "failed", message: "mikhail-mbp went offline." };
    localComputer.openImport(laptop.id);
    await show();

    await expect.element(page.getByRole("alert")).toHaveTextContent("went offline");
  });
});

describe("the connectors row", () => {
  it("counts what's already imported", async () => {
    importStatus = { ...idle, importedChats: 88, importedProjects: 6 };
    await show();

    await expect
      .element(page.getByTestId(`connector-computer-${laptop.id}`))
      .toHaveTextContent("88 chats · 6 projects");
  });
});

describe("an imported chat instead of the message box", () => {
  const source: ThreadComputerSource = {
    kind: "computer",
    computerId: laptop.id,
    computerName: laptop.name,
    tool: "claude",
    sessionId: "session-1",
    path: "~/.claude/projects/app/session-1.jsonl",
    cwd: "/Users/me/app",
    lastActiveAt: "2026-10-31T10:00:00Z",
  };
  const note = (history: MyComputerChatHistory | undefined, onRetry = vi.fn()) =>
    render(
      <ImportedChatNote source={source} history={history} loading={false} onRetry={onRetry} />,
    );

  it("says what it is, with no way to send", async () => {
    await note({ kind: "ready", messages: [], truncated: false, stale: false });
    await expect
      .element(page.getByTestId("imported-chat-note"))
      .toHaveTextContent("Imported from mikhail-mbp. Continuing here is coming soon.");
    await expect.element(page.getByRole("textbox")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button")).not.toBeInTheDocument();
  });

  it("explains an offline computer and lets you try again", async () => {
    const onRetry = vi.fn();
    await note({ kind: "offline", computerName: laptop.name }, onRetry);
    await expect
      .element(page.getByTestId("imported-chat-notice"))
      .toHaveTextContent("mikhail-mbp is offline. Turn it on to open this chat.");
    await page.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
