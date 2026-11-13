import { beforeEach, describe, expect, it, vi } from "vitest";

const accountRequest = vi.fn();
vi.mock("../account/unoAccount", () => ({
  AccountHttpError: class extends Error {
    status = 0;
  },
  AccountSignInRequiredError: class extends Error {},
  accountRequest: (...args: unknown[]) => accountRequest(...args),
  accountTransport: () => "work-proxy",
}));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../lib/externalLinks", () => ({ openUntrustedLinkExternally: vi.fn(() => true) }));

import { featureFlagDefault } from "../featureFlags";
import {
  refreshDeployApprovals,
  setDeployApprovalsEnabled,
  useDeployApprovalsStore,
} from "./deployApprovalsStore";

const ANSWER = {
  approver: true,
  frozen: false,
  web: false,
  passkeys: 0,
  requests: [{ id: 3, machine: "box-395", summary: "x", minutes: 10, status: "requested" }],
};

describe("deploy approvals behind the Labs flag (Misha 13.11)", () => {
  beforeEach(() => {
    accountRequest.mockReset().mockResolvedValue(ANSWER);
    setDeployApprovalsEnabled(false);
  });

  it("is off by default, the stage channel too", () => {
    expect(featureFlagDefault("deployApprovals", false)).toBe(false);
    expect(featureFlagDefault("deployApprovals", true)).toBe(false);
  });

  it("off: never asks the console, keeps nothing", async () => {
    expect(await refreshDeployApprovals()).toBeNull();
    expect(accountRequest).not.toHaveBeenCalled();
    expect(useDeployApprovalsStore.getState().gate).toBeNull();
  });

  it("on: asks; off again: the cards and counts are gone", async () => {
    setDeployApprovalsEnabled(true);
    const gate = await refreshDeployApprovals();
    expect(accountRequest).toHaveBeenCalledWith("GET", "/api/v1/ops-gate/inbox");
    expect(gate?.requests).toHaveLength(1);
    setDeployApprovalsEnabled(false);
    expect(useDeployApprovalsStore.getState().gate).toBeNull();
  });

  it("turned off while asking: the answer is dropped", async () => {
    setDeployApprovalsEnabled(true);
    const pending = refreshDeployApprovals();
    setDeployApprovalsEnabled(false);
    expect(await pending).toBeNull();
    expect(useDeployApprovalsStore.getState().gate).toBeNull();
  });
});
