import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  state: vi.fn(),
  decide: vi.fn(),
  setAllowed: vi.fn(),
  revokeTrust: vi.fn(),
};
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ chatRequests: api }),
}));
vi.mock("../environments/primary", () => ({ usePrimaryEnvironmentDescriptor: () => null }));
vi.mock("../hooks/useMachineRows", () => ({ useMachineRows: () => [] }));

import {
  decideChatRequest,
  refreshChatRequests,
  revokeChatRequestTrust,
  setChatRequestsAllowed,
  setChatRequestsHost,
  stopCloudAgents,
  useChatRequestsStore,
} from "./chatRequestsStore";

const HOST = "env-mac" as EnvironmentId;
const STATE = { allow: true, limit: 2, active: 0, requests: [] };

describe("chat requests store", () => {
  beforeEach(() => {
    api.state.mockReset().mockResolvedValue(STATE);
    api.decide.mockReset();
    api.setAllowed.mockReset();
    api.revokeTrust.mockReset();
    setChatRequestsHost(null);
  });

  it("asks nothing on a cloud computer (no host)", async () => {
    expect(await refreshChatRequests()).toBeNull();
    expect(api.state).not.toHaveBeenCalled();
  });

  it("keeps this computer's answer", async () => {
    setChatRequestsHost(HOST);
    await refreshChatRequests();
    expect(useChatRequestsStore.getState().state).toEqual(STATE);
  });

  it("Start returns the chat the server opened and closes its brief", async () => {
    setChatRequestsHost(HOST);
    useChatRequestsStore.setState({ briefId: "a" });
    api.decide.mockResolvedValue({ state: { ...STATE, active: 1 }, threadId: "t-new" });
    const outcome = await decideChatRequest("a", "start");
    expect(api.decide).toHaveBeenCalledWith({ id: "a", decision: "start" });
    expect(outcome).toEqual({ ok: true, threadId: "t-new", hostId: HOST });
    expect(useChatRequestsStore.getState().briefId).toBeNull();
    expect(useChatRequestsStore.getState().busy).toEqual({});
  });

  it("a refusal carries the server's sentence", async () => {
    setChatRequestsHost(HOST);
    api.decide.mockRejectedValue({ _tag: "ChatRequestsError", message: "2 at once already." });
    expect(await decideChatRequest("a", "start")).toEqual({
      ok: false,
      message: "2 at once already.",
    });
  });

  it("the switch saves and keeps what the server answers", async () => {
    setChatRequestsHost(HOST);
    api.setAllowed.mockResolvedValue({ ...STATE, allow: false });
    expect(await setChatRequestsAllowed(false)).toBeNull();
    expect(api.setAllowed).toHaveBeenCalledWith({ allow: false });
    expect(useChatRequestsStore.getState().state?.allow).toBe(false);
  });

  it("Start with “Don't ask again” trusts that chat; Decline never does", async () => {
    setChatRequestsHost(HOST);
    api.decide.mockResolvedValue({ state: STATE, threadId: "t-new" });
    await decideChatRequest("a", "start", true);
    expect(api.decide).toHaveBeenLastCalledWith({ id: "a", decision: "start", trustChat: true });
    await decideChatRequest("b", "decline", true);
    expect(api.decide).toHaveBeenLastCalledWith({ id: "b", decision: "decline" });
  });

  it("Stop cloud agents turns the switch off and stops what runs", async () => {
    setChatRequestsHost(HOST);
    api.setAllowed.mockResolvedValue({ ...STATE, allow: false, stoppedAt: "2026-11-23T10:00:00Z" });
    expect(await stopCloudAgents()).toBeNull();
    expect(api.setAllowed).toHaveBeenCalledWith({ allow: false, stopRunning: true });
    expect(useChatRequestsStore.getState().state?.stoppedAt).toBe("2026-11-23T10:00:00Z");
  });

  it("Revoke asks the server and keeps its answer", async () => {
    setChatRequestsHost(HOST);
    api.revokeTrust.mockResolvedValue({ ...STATE, trustedChats: [] });
    expect(await revokeChatRequestTrust({ boxId: 395, threadId: "t-1" })).toBeNull();
    expect(api.revokeTrust).toHaveBeenCalledWith({ boxId: 395, threadId: "t-1" });
    expect(useChatRequestsStore.getState().state?.trustedChats).toEqual([]);
  });
});
