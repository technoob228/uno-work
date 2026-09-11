import { describe, expect, it } from "@effect/vitest";
import { ApprovalRequestId, ProjectId, ThreadId } from "@t3tools/contracts";

import {
  approvalDecisionForCommand,
  decideApprovalAction,
  parseConnectorCommand,
} from "./connectorCommands.ts";

describe("parseConnectorCommand", () => {
  it("parses every command, case-insensitively, with trimmed arguments", () => {
    expect(parseConnectorCommand("/use  Uno API ", null)).toEqual({
      name: "use",
      query: "Uno API",
    });
    expect(parseConnectorCommand("/THREAD thread-1", null)).toEqual({
      name: "thread",
      query: "thread-1",
    });
    expect(parseConnectorCommand("/use", null)).toEqual({ name: "use", query: "" });
    expect(parseConnectorCommand("/assistant", null)).toEqual({ name: "assistant" });
    expect(parseConnectorCommand("/where", null)).toEqual({ name: "where" });
    expect(parseConnectorCommand("/threads", null)).toEqual({ name: "threads" });
    expect(parseConnectorCommand("/approve", null)).toEqual({ name: "approve" });
    expect(parseConnectorCommand("/deny", null)).toEqual({ name: "deny" });
  });

  it("accepts the @botname suffix Telegram adds in groups, but not another bot's", () => {
    expect(parseConnectorCommand("/where@Antoha_bot", "antoha_bot")).toEqual({ name: "where" });
    expect(parseConnectorCommand("/use@antoha_bot api", "antoha_bot")).toEqual({
      name: "use",
      query: "api",
    });
    expect(parseConnectorCommand("/where@other_bot", "antoha_bot")).toBeNull();
    // Unknown bot name (not resolved yet): treat the command as ours.
    expect(parseConnectorCommand("/where@antoha_bot", null)).toEqual({ name: "where" });
  });

  it("leaves ordinary text and unknown slash commands to the bound target", () => {
    expect(parseConnectorCommand("where is my report", null)).toBeNull();
    expect(parseConnectorCommand("/start", null)).toBeNull();
    expect(parseConnectorCommand("/help", null)).toBeNull();
    expect(parseConnectorCommand("please /approve this", null)).toBeNull();
    expect(parseConnectorCommand("", null)).toBeNull();
  });

  it("maps approve/deny to the provider decision", () => {
    expect(approvalDecisionForCommand({ name: "approve" })).toBe("accept");
    expect(approvalDecisionForCommand({ name: "deny" })).toBe("decline");
  });
});

describe("decideApprovalAction", () => {
  const projectId = ProjectId.make("project-1");
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");
  const req = (id: string) => ApprovalRequestId.make(id);

  it("is unsupported for the assistant target", () => {
    expect(
      decideApprovalAction({ kind: "assistant", projectId: ProjectId.make("assistant-home") }, [
        { threadId: threadA, threadTitle: "A", requestIds: [req("r1")] },
      ]),
    ).toEqual({ kind: "unsupported-target" });
  });

  it("resolves the oldest pending request of the bound thread only", () => {
    const candidates = [
      { threadId: threadA, threadTitle: "A", requestIds: [req("r1"), req("r2")] },
      { threadId: threadB, threadTitle: "B", requestIds: [req("r3")] },
    ];
    expect(decideApprovalAction({ kind: "thread", threadId: threadA }, candidates)).toEqual({
      kind: "respond",
      threadId: threadA,
      threadTitle: "A",
      requestId: req("r1"),
    });
    expect(
      decideApprovalAction({ kind: "thread", threadId: threadA }, [
        { threadId: threadA, threadTitle: "A", requestIds: [] },
      ]),
    ).toEqual({ kind: "nothing-pending" });
  });

  it("for a project target acts only when exactly one thread is pending", () => {
    expect(
      decideApprovalAction({ kind: "project", projectId }, [
        { threadId: threadA, threadTitle: "A", requestIds: [] },
        { threadId: threadB, threadTitle: "B", requestIds: [req("r3")] },
      ]),
    ).toEqual({ kind: "respond", threadId: threadB, threadTitle: "B", requestId: req("r3") });
    const ambiguous = decideApprovalAction({ kind: "project", projectId }, [
      { threadId: threadA, threadTitle: "A", requestIds: [req("r1")] },
      { threadId: threadB, threadTitle: "B", requestIds: [req("r3")] },
    ]);
    expect(ambiguous.kind).toBe("ambiguous");
    expect(ambiguous.kind === "ambiguous" && ambiguous.candidates.map((c) => c.threadId)).toEqual([
      threadA,
      threadB,
    ]);
    expect(decideApprovalAction({ kind: "project", projectId }, [])).toEqual({
      kind: "nothing-pending",
    });
  });
});
