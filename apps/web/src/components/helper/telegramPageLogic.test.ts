import type {
  ManagerAssistantSummary,
  ManagerConnectorBindingView,
  ManagerTelegramConnectorStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { ASSISTANT_PROJECT_ID, DEFAULT_CONNECTOR_ADDRESSING } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  addChatId,
  addressingConfigFromForm,
  addressingFormFromConfig,
  buildChatRows,
  changeRouteKind,
  describeTelegramStatus,
  formatChatTitle,
  HELPER_ROUTE,
  notifyBindingTarget,
  parseTelegramChatId,
  pickHelper,
  planBindingWrite,
  readChatLabels,
  removeChatId,
  routeFromBinding,
  splitIdList,
  splitNameList,
  withChatLabel,
  writeChatLabels,
} from "./telegramPageLogic";

const telegram = (
  overrides: Partial<ManagerTelegramConnectorStatus> = {},
): ManagerTelegramConnectorStatus => ({
  configured: true,
  enabled: true,
  allowedChatIds: [],
  botUsername: "uno_helper_bot",
  lastError: null,
  health: null,
  defaultModelSelection: null,
  addressing: DEFAULT_CONNECTOR_ADDRESSING,
  ...overrides,
});

const binding = (
  overrides: Partial<ManagerConnectorBindingView> = {},
): ManagerConnectorBindingView => ({
  kind: "telegram",
  chatId: "1",
  connectorProjectId: ASSISTANT_PROJECT_ID,
  target: { kind: "project", projectId: "proj-a" as ProjectId },
  notifyOnComplete: false,
  updatedAt: "2026-09-11T00:00:00.000Z",
  targetLabel: "Project A",
  ...overrides,
});

describe("describeTelegramStatus", () => {
  it("is 'Not connected' without a configured bot", () => {
    expect(describeTelegramStatus(null)).toEqual({ tone: "muted", text: "Not connected" });
    expect(describeTelegramStatus(telegram({ configured: false }))).toEqual({
      tone: "muted",
      text: "Not connected",
    });
  });

  it("is 'Paused' when configured but disabled", () => {
    expect(describeTelegramStatus(telegram({ enabled: false })).text).toBe("Paused");
  });

  it("is 'Connecting…' before the first poll", () => {
    expect(describeTelegramStatus(telegram())).toEqual({ tone: "warning", text: "Connecting…" });
  });

  it("surfaces the poller error before the first poll", () => {
    expect(describeTelegramStatus(telegram({ lastError: "invalid token" }))).toEqual({
      tone: "error",
      text: "Needs attention: invalid token",
    });
  });

  it("names the bot when healthy", () => {
    const status = describeTelegramStatus(
      telegram({
        health: { status: "connected", lastOkAt: null, lastError: null, lastErrorAt: null },
      }),
    );
    expect(status).toEqual({ tone: "success", text: "Connected as @uno_helper_bot" });
    expect(
      describeTelegramStatus(
        telegram({
          botUsername: null,
          health: { status: "connected", lastOkAt: null, lastError: null, lastErrorAt: null },
        }),
      ).text,
    ).toBe("Connected");
  });

  it("explains unhealthy states with the last error", () => {
    const status = describeTelegramStatus(
      telegram({
        health: {
          status: "auth_expired",
          lastOkAt: null,
          lastError: "401 Unauthorized",
          lastErrorAt: null,
        },
      }),
    );
    expect(status).toEqual({
      tone: "error",
      text: "Needs attention: Auth expired — 401 Unauthorized",
    });
    expect(
      describeTelegramStatus(
        telegram({
          health: { status: "reconnecting", lastOkAt: null, lastError: null, lastErrorAt: null },
        }),
      ),
    ).toEqual({ tone: "warning", text: "Needs attention: Reconnecting" });
  });
});

describe("pickHelper", () => {
  const summary = (projectId: string): ManagerAssistantSummary =>
    ({ projectId: projectId as ProjectId }) as ManagerAssistantSummary;

  it("prefers the default assistant, then the first one, then null", () => {
    expect(pickHelper([])).toBeNull();
    expect(pickHelper([summary("assistant-x")])?.projectId).toBe("assistant-x");
    expect(pickHelper([summary("assistant-x"), summary(ASSISTANT_PROJECT_ID)])?.projectId).toBe(
      ASSISTANT_PROJECT_ID,
    );
  });
});

describe("chat ids", () => {
  it("accepts integer ids only", () => {
    expect(parseTelegramChatId(" 128841517 ")).toBe("128841517");
    expect(parseTelegramChatId("-1001234567890")).toBe("-1001234567890");
    expect(parseTelegramChatId("@someone")).toBeNull();
    expect(parseTelegramChatId("")).toBeNull();
  });

  it("splits id and name lists", () => {
    expect(splitIdList("1, 2;3\n4  5")).toEqual(["1", "2", "3", "4", "5"]);
    expect(splitNameList("Антоха, Uno Bot; Антон\n")).toEqual(["Антоха", "Uno Bot", "Антон"]);
  });

  it("adds without duplicates and removes", () => {
    expect(addChatId(["1"], "1")).toEqual(["1"]);
    expect(addChatId(["1"], "2")).toEqual(["1", "2"]);
    expect(removeChatId(["1", "2"], "1")).toEqual(["2"]);
  });
});

describe("buildChatRows", () => {
  it("joins allowed chats with their telegram bindings, ignoring slack ones", () => {
    const rows = buildChatRows(
      ["1", "2"],
      [binding({ chatId: "2" }), binding({ chatId: "1", kind: "slack" })],
    );
    expect(rows.map((row) => [row.chatId, row.binding?.chatId ?? null])).toEqual([
      ["1", null],
      ["2", "2"],
    ]);
  });
});

describe("routeFromBinding / changeRouteKind", () => {
  const projectOfThread = (threadId: ThreadId) =>
    threadId === "thr-1" ? ("proj-a" as ProjectId) : null;

  it("maps unbound and assistant targets to Helper", () => {
    expect(routeFromBinding(null, projectOfThread)).toEqual(HELPER_ROUTE);
    expect(
      routeFromBinding(
        binding({ target: { kind: "assistant", projectId: ASSISTANT_PROJECT_ID } }),
        projectOfThread,
      ),
    ).toEqual(HELPER_ROUTE);
  });

  it("maps project and thread targets, resolving the thread's project", () => {
    expect(routeFromBinding(binding(), projectOfThread)).toEqual({
      kind: "project",
      projectId: "proj-a",
      threadId: null,
    });
    expect(
      routeFromBinding(
        binding({ target: { kind: "thread", threadId: "thr-1" as ThreadId } }),
        projectOfThread,
      ),
    ).toEqual({ kind: "thread", projectId: "proj-a", threadId: "thr-1" });
    expect(
      routeFromBinding(
        binding({ target: { kind: "thread", threadId: "gone" as ThreadId } }),
        projectOfThread,
      ).projectId,
    ).toBeNull();
  });

  it("keeps the chosen project when switching between project and thread", () => {
    const projectRoute = {
      kind: "project",
      projectId: "proj-a" as ProjectId,
      threadId: null,
    } as const;
    expect(changeRouteKind(projectRoute, "thread")).toEqual({
      kind: "thread",
      projectId: "proj-a",
      threadId: null,
    });
    expect(changeRouteKind(projectRoute, "helper")).toEqual(HELPER_ROUTE);
  });
});

describe("planBindingWrite", () => {
  it("removes the binding when Helper is chosen for a bound chat", () => {
    expect(planBindingWrite(HELPER_ROUTE, binding())).toEqual({ action: "remove" });
    expect(planBindingWrite(HELPER_ROUTE, null)).toEqual({ action: "none" });
    expect(
      planBindingWrite(
        HELPER_ROUTE,
        binding({ target: { kind: "assistant", projectId: ASSISTANT_PROJECT_ID } }),
      ),
    ).toEqual({ action: "none" });
  });

  it("attaches the notify flag to the existing binding or an explicit Helper one", () => {
    expect(notifyBindingTarget(HELPER_ROUTE, binding(), ASSISTANT_PROJECT_ID)).toEqual(
      binding().target,
    );
    expect(notifyBindingTarget(HELPER_ROUTE, null, ASSISTANT_PROJECT_ID)).toEqual({
      kind: "assistant",
      projectId: ASSISTANT_PROJECT_ID,
    });
    expect(
      notifyBindingTarget(
        { kind: "project", projectId: null, threadId: null },
        null,
        ASSISTANT_PROJECT_ID,
      ),
    ).toBeNull();
  });

  it("writes nothing until the picker is filled in", () => {
    expect(planBindingWrite({ kind: "project", projectId: null, threadId: null }, null)).toEqual({
      action: "none",
    });
    expect(
      planBindingWrite({ kind: "thread", projectId: "proj-a" as ProjectId, threadId: null }, null),
    ).toEqual({ action: "none" });
  });

  it("upserts a changed target and skips an unchanged one", () => {
    expect(
      planBindingWrite(
        { kind: "project", projectId: "proj-b" as ProjectId, threadId: null },
        binding(),
      ),
    ).toEqual({ action: "upsert", target: { kind: "project", projectId: "proj-b" } });
    expect(
      planBindingWrite(
        { kind: "project", projectId: "proj-a" as ProjectId, threadId: null },
        binding(),
      ),
    ).toEqual({ action: "none" });
    expect(
      planBindingWrite(
        { kind: "thread", projectId: "proj-a" as ProjectId, threadId: "thr-1" as ThreadId },
        binding(),
      ),
    ).toEqual({ action: "upsert", target: { kind: "thread", threadId: "thr-1" } });
  });
});

const memoryStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
};

describe("chat labels", () => {
  it("round-trips through storage and drops junk", () => {
    const storage = memoryStorage();
    writeChatLabels(storage, "k", withChatLabel({}, "1", "  Me "));
    expect(readChatLabels(storage, "k")).toEqual({ "1": "Me" });
    storage.setItem("k", '{"1": 5, "2": " ", "3": "Family"}');
    expect(readChatLabels(storage, "k")).toEqual({ "3": "Family" });
    storage.setItem("k", "not json");
    expect(readChatLabels(storage, "k")).toEqual({});
    expect(readChatLabels(null, "k")).toEqual({});
  });

  it("clears a label with empty input and formats titles", () => {
    const labels = withChatLabel({ "1": "Me", "2": "Group" }, "1", "");
    expect(labels).toEqual({ "2": "Group" });
    expect(formatChatTitle("2", labels)).toBe("Group · 2");
    expect(formatChatTitle("1", labels)).toBe("1");
  });
});

describe("addressing form", () => {
  it("round-trips the contract and clamps the window", () => {
    const form = addressingFormFromConfig({
      names: ["Антоха", "Антон"],
      requireMentionInGroups: false,
      smartWake: true,
      hotWindowSec: 45,
    });
    expect(form).toEqual({
      names: "Антоха, Антон",
      requireMention: false,
      smartWake: true,
      hotWindowSec: "45",
    });
    expect(addressingConfigFromForm({ ...form, hotWindowSec: "-3.7" })).toEqual({
      names: ["Антоха", "Антон"],
      requireMentionInGroups: false,
      smartWake: true,
      hotWindowSec: 0,
    });
    expect(addressingConfigFromForm({ ...form, hotWindowSec: "abc" }).hotWindowSec).toBe(0);
  });
});
