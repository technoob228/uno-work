import { describe, expect, it } from "vitest";

import {
  parseUnoBox,
  parseUnoBoxConnection,
  parseUnoBoxList,
  controlPlaneErrorStatus,
  ControlPlaneHttpError,
  parseUnoWorkImage,
} from "./unoCloudParse.ts";

describe("parseUnoBox", () => {
  it("maps a control-plane box record to the contract shape", () => {
    expect(
      parseUnoBox({
        id: 12,
        name: "my-app",
        status: "running",
        os: "ubuntu-24.04",
        ram_mb: 2048,
        vcpu: 1,
        disk_gb: 10,
        ssh: "ssh -p 30000 uno@45.182.189.80",
        public_ip: "45.182.189.80",
        internal_ip: "10.0.0.5",
        created_at: "2026-09-09T10:00:00Z",
        sleep_deadline_at: null,
        hostname: "my-app-u85.app.uno4.dev",
        url: "https://my-app-u85.app.uno4.dev",
      }),
    ).toEqual({
      id: 12,
      name: "my-app",
      status: "running",
      os: "ubuntu-24.04",
      ramMb: 2048,
      vcpu: 1,
      diskGb: 10,
      ssh: "ssh -p 30000 uno@45.182.189.80",
      publicIp: "45.182.189.80",
      internalIp: "10.0.0.5",
      createdAt: "2026-09-09T10:00:00Z",
      sleepDeadlineAt: null,
      // The published address: the phone QR and pairing links behind
      // app.uno4.work need it to reach the daemon directly.
      hostname: "my-app-u85.app.uno4.dev",
      url: "https://my-app-u85.app.uno4.dev",
      workMachine: false,
    });
  });

  it("fills defaults for a freshly launched box that has almost nothing yet", () => {
    const box = parseUnoBox({ id: 7, status: "provisioning", provision_state: "queued" });
    expect(box).toMatchObject({
      id: 7,
      name: "box-7",
      status: "provisioning",
      os: "",
      ramMb: 0,
      ssh: null,
      publicIp: null,
    });
  });

  it("rejects records without a numeric id", () => {
    expect(parseUnoBox({ name: "x" })).toBeNull();
    expect(parseUnoBox({ id: "12" })).toBeNull();
    expect(parseUnoBox(null)).toBeNull();
    expect(parseUnoBox("box")).toBeNull();
  });
});

describe("parseUnoBoxList", () => {
  it("reads the { boxes } envelope and drops junk entries", () => {
    const boxes = parseUnoBoxList({ boxes: [{ id: 1, name: "a" }, { nope: true }, { id: 2 }] });
    expect(boxes.map((box) => box.id)).toEqual([1, 2]);
  });

  it("accepts a bare array and tolerates missing payloads", () => {
    expect(parseUnoBoxList([{ id: 3 }]).map((box) => box.id)).toEqual([3]);
    expect(parseUnoBoxList({})).toEqual([]);
    expect(parseUnoBoxList(undefined)).toEqual([]);
    expect(parseUnoBoxList({ boxes: "nope" })).toEqual([]);
  });
});

describe("parseUnoBoxConnection", () => {
  it("returns a pairing handle when the control plane gives a url", () => {
    expect(
      parseUnoBoxConnection(
        { url: "https://h/pair#token=t", hostname: "h", expires_at: "2026-09-09T10:05:00Z" },
        5,
      ),
    ).toEqual({
      boxId: 5,
      url: "https://h/pair#token=t",
      hostname: "h",
      expiresAt: "2026-09-09T10:05:00Z",
    });
  });

  it("is null without a url so callers can keep retrying", () => {
    expect(parseUnoBoxConnection({ hostname: "h" }, 5)).toBeNull();
    expect(parseUnoBoxConnection({ url: "" }, 5)).toBeNull();
    expect(parseUnoBoxConnection(null, 5)).toBeNull();
  });
});

describe("parseUnoWorkImage", () => {
  it("reads the work image payload", () => {
    expect(
      parseUnoWorkImage({ image_id: 126, name: "uno-work-golden-v9", state: "ready" }),
    ).toEqual({ id: 126, state: "ready" });
  });

  it("returns null for anything that is not a work image", () => {
    expect(parseUnoWorkImage(null)).toBeNull();
    expect(parseUnoWorkImage("404 page not found")).toBeNull();
    expect(parseUnoWorkImage({ id: 126 })).toBeNull();
    expect(parseUnoWorkImage({ image_id: 0 })).toBeNull();
  });
});

describe("controlPlaneErrorStatus", () => {
  it("reads the status from typed and message-only errors", () => {
    expect(controlPlaneErrorStatus(new ControlPlaneHttpError(404, "HTTP 404"))).toBe(404);
    expect(controlPlaneErrorStatus(new Error("404: NOT_FOUND"))).toBe(404);
    expect(controlPlaneErrorStatus(new Error("HTTP 409"))).toBe(409);
    expect(controlPlaneErrorStatus(new Error("fetch failed"))).toBeNull();
  });
});
