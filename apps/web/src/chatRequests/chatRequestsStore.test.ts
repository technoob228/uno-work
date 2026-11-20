import type { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = {
  state: vi.fn(),
  decide: vi.fn(),
  setAllowed: vi.fn(),
};
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ chatRequests: api }),
}));
vi.mock("../environments/primary", () => ({ usePrimaryEnvironmentDescriptor: () => null }));
vi.mock("../hooks/useMachineRows", () => ({ useMachineRows: () => [] }));

import {
  decideChatRequest,
  refreshChatRequests,
  setChatRequestsAllowed,
  setChatRequestsHost,
  useChatRequestsStore,
} from "./chatRequestsStore";

const HOST = "env-mac" as EnvironmentId;
const STATE = { allow: true, limit: 2, active: 0, requests: [] };

describe("chat requests store", () => {
  beforeEach(() => {
    api.state.mockReset().mockResolvedValue(STATE);
    api.decide.mockReset();
    api.setAllowed.mockReset();
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
});
