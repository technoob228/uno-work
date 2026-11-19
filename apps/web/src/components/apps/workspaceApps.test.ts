import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { placeApp, type WorkspaceComputer } from "./workspaceApps";

const MAC = "env-mac" as EnvironmentId;
const CLOUD = "env-395" as EnvironmentId;
const SPARE = "env-spare" as EnvironmentId;

const app = (
  id: string,
  status: "running" | "stopped" | "unknown",
  port: number | null,
  canStart = true,
) => ({ id, status, port, canStart });

const computer = (
  environmentId: EnvironmentId,
  kind: WorkspaceComputer["kind"],
  apps: WorkspaceComputer["apps"],
  online = true,
): WorkspaceComputer => ({ environmentId, label: environmentId, kind, online, apps });

describe("placeApp — by app id", () => {
  // 19.11: «ComputeSDK live» registered under the same id on the Mac (old) and on 395 (new).
  const both = [
    computer(MAC, "computer", [app("manifest:csdk-live", "running", 8698)]),
    computer(CLOUD, "uno_box", [app("manifest:csdk-live", "running", 8731)]),
  ];

  it("opens the one on the computer that stays on, not the active laptop's copy", () => {
    const placed = placeApp({ key: "manifest:csdk-live", active: MAC, computers: both });
    expect(placed.environmentId).toBe(CLOUD);
    expect(placed.instances.map((entry) => entry.environmentId)).toEqual([CLOUD, MAC]);
  });

  it("honours the computer the link names", () => {
    const placed = placeApp({
      key: "manifest:csdk-live",
      explicit: MAC,
      active: CLOUD,
      computers: both,
    });
    expect(placed.environmentId).toBe(MAC);
    expect(placed.instances.map((entry) => entry.environmentId)).toEqual([MAC, CLOUD]);
  });

  it("finds an app that isn't on the active computer at all", () => {
    const placed = placeApp({
      key: "manifest:csdk-dash",
      active: MAC,
      computers: [
        computer(MAC, "computer", []),
        computer(CLOUD, "uno_box", [app("manifest:csdk-dash", "running", 8731)]),
      ],
    });
    expect(placed.environmentId).toBe(CLOUD);
  });

  it("prefers a running copy over a stopped one, then one it can start", () => {
    const placed = placeApp({
      key: "manifest:notes",
      active: CLOUD,
      computers: [
        computer(CLOUD, "uno_box", [app("manifest:notes", "stopped", 3000, false)]),
        computer(SPARE, "uno_box", [app("manifest:notes", "stopped", 3000, true)]),
        computer(MAC, "computer", [app("manifest:notes", "running", 3000)]),
      ],
    });
    expect(placed.instances.map((entry) => entry.environmentId)).toEqual([MAC, SPARE, CLOUD]);
  });

  it("puts a copy on a computer that is off last", () => {
    const placed = placeApp({
      key: "manifest:notes",
      active: MAC,
      computers: [
        computer(CLOUD, "uno_box", [app("manifest:notes", "running", 3000)], false),
        computer(MAC, "computer", [app("manifest:notes", "stopped", 3000)]),
      ],
    });
    expect(placed.environmentId).toBe(MAC);
    expect(placed.instances.at(-1)?.online).toBe(false);
  });

  it("keeps the active computer when the app is nowhere", () => {
    expect(placeApp({ key: "manifest:gone", active: MAC, computers: both })).toEqual({
      environmentId: MAC,
      instances: [],
    });
  });
});

describe("placeApp — by a computer's localhost address", () => {
  it("keeps the active computer when its port answers", () => {
    const placed = placeApp({
      url: "http://localhost:8731/",
      active: MAC,
      computers: [
        computer(MAC, "computer", [app("port:8731", "running", 8731)]),
        computer(CLOUD, "uno_box", [app("manifest:csdk-live", "running", 8731)]),
      ],
    });
    expect(placed.environmentId).toBe(MAC);
  });

  it("goes to the computer where the port runs when the active one has nothing there", () => {
    const placed = placeApp({
      url: "http://localhost:8731/",
      active: MAC,
      computers: [
        computer(MAC, "computer", [app("manifest:csdk-live", "running", 8698)]),
        computer(CLOUD, "uno_box", [app("manifest:csdk-live", "running", 8731)]),
      ],
    });
    expect(placed.environmentId).toBe(CLOUD);
  });

  it("leaves other addresses to the active computer", () => {
    expect(
      placeApp({ url: "https://example.com/", active: MAC, computers: [] }).environmentId,
    ).toBe(MAC);
  });
});
