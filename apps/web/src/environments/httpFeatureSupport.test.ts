import { HTTP_FEATURES } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isMissingRouteResponse } from "./http/target";
import {
  descriptorSupportsHttpFeature,
  httpFeatureForPath,
  updateComputerToUseCopy,
} from "./httpFeatureSupport";

const descriptor = (serverVersion: string, httpFeatures?: string[]) => ({
  serverVersion,
  capabilities: {
    repositoryIdentity: true,
    ...(httpFeatures ? { httpFeatures } : {}),
  },
});

describe("descriptorSupportsHttpFeature", () => {
  it("trusts the daemon's list when it has one", () => {
    expect(
      descriptorSupportsHttpFeature(
        descriptor("0.0.119", ["self-update"]),
        HTTP_FEATURES.selfUpdate,
      ),
    ).toBe(true);
    expect(descriptorSupportsHttpFeature(descriptor("0.0.119", []), HTTP_FEATURES.selfUpdate)).toBe(
      false,
    );
    // A newer daemon may list names this client never heard of — harmless.
    expect(
      descriptorSupportsHttpFeature(
        descriptor("0.0.130", ["teleport", "assistants-trash"]),
        HTTP_FEATURES.assistantsTrash,
      ),
    ).toBe(true);
  });

  it("judges a daemon from before the list by its version", () => {
    expect(descriptorSupportsHttpFeature(descriptor("0.0.113"), HTTP_FEATURES.selfUpdate)).toBe(
      true,
    );
    expect(descriptorSupportsHttpFeature(descriptor("0.0.112"), HTTP_FEATURES.selfUpdate)).toBe(
      false,
    );
    expect(
      descriptorSupportsHttpFeature(descriptor("0.0.105"), HTTP_FEATURES.assistantWorkspace),
    ).toBe(false);
    expect(
      descriptorSupportsHttpFeature(descriptor("v0.0.106"), HTTP_FEATURES.assistantWorkspace),
    ).toBe(true);
  });

  it("unknown daemon (not connected yet) → no", () => {
    expect(descriptorSupportsHttpFeature(null, HTTP_FEATURES.selfUpdate)).toBe(false);
  });
});

describe("httpFeatureForPath", () => {
  it("maps feature routes and leaves everyday routes alone", () => {
    expect(httpFeatureForPath("/api/self-update/start")).toBe("self-update");
    expect(httpFeatureForPath("/api/manager/assistant/draft")).toBe("assistant-workspace");
    expect(httpFeatureForPath("/api/manager/assistants/restore")).toBe("assistants-trash");
    expect(httpFeatureForPath("/api/manager/assistants")).toBeNull();
    expect(httpFeatureForPath("/api/manager/assistant/telegram")).toBeNull();
  });
});

describe("isMissingRouteResponse", () => {
  const response = (status: number, contentType: string | null) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(contentType ? { "content-type": contentType } : {}),
  });

  it("an older daemon: plain 404, or its index.html for a GET under /api", () => {
    expect(isMissingRouteResponse(response(404, "text/plain"))).toBe(true);
    expect(isMissingRouteResponse(response(404, null))).toBe(true);
    expect(isMissingRouteResponse(response(200, "text/html; charset=utf-8"))).toBe(true);
  });

  it("our routes answer JSON — a JSON 404 is a real 'not found', a JSON 200 is fine", () => {
    expect(isMissingRouteResponse(response(404, "application/json"))).toBe(false);
    expect(isMissingRouteResponse(response(200, "application/json"))).toBe(false);
    expect(isMissingRouteResponse(response(500, "text/plain"))).toBe(false);
  });
});

describe("updateComputerToUseCopy", () => {
  it("names the computer and its version", () => {
    expect(updateComputerToUseCopy("Ana's computer", "0.0.108")).toBe(
      "Ana's computer runs Uno Work 0.0.108. Update this computer to use this.",
    );
    expect(updateComputerToUseCopy(null, null)).toBe(
      "This computer runs an older Uno Work. Update this computer to use this.",
    );
  });
});
