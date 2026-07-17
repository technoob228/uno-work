import { describe, expect, it } from "vitest";

import {
  isTransportConnectionErrorMessage,
  isTransportInterruptErrorMessage,
  sanitizeThreadErrorMessage,
  TRANSPORT_CONNECTION_LOST_MESSAGE,
  TransportConnectionLostError,
} from "./transportError";

describe("transportError", () => {
  it("detects websocket transport failures", () => {
    expect(isTransportConnectionErrorMessage("SocketCloseError: 1006")).toBe(true);
    expect(isTransportConnectionErrorMessage("Unable to connect to the T3 server WebSocket.")).toBe(
      true,
    );
    expect(isTransportConnectionErrorMessage("SocketOpenError: Timeout")).toBe(true);
  });

  it("detects rpc client defects raised by a dead socket", () => {
    expect(isTransportConnectionErrorMessage("RpcClientDefect: Unknown socket error")).toBe(true);
    expect(isTransportConnectionErrorMessage("RpcClientDefect: Error decoding message")).toBe(true);
    expect(isTransportConnectionErrorMessage("SocketWriteError: send failed")).toBe(true);
  });

  it("treats the typed connection-lost error as a transport failure", () => {
    const error = new TransportConnectionLostError(new Error("SocketCloseError: 1006"));
    expect(error.message).toBe(TRANSPORT_CONNECTION_LOST_MESSAGE);
    expect(error.name).toBe("TransportConnectionLostError");
    expect(isTransportConnectionErrorMessage(error.message)).toBe(true);
    expect(sanitizeThreadErrorMessage(error.message)).toBeNull();
  });

  it("detects interrupt-shaped rejections", () => {
    expect(isTransportInterruptErrorMessage("All fibers interrupted without error")).toBe(true);
    expect(isTransportInterruptErrorMessage("Turn failed")).toBe(false);
  });

  it("preserves non-transport thread errors", () => {
    expect(sanitizeThreadErrorMessage("Turn failed")).toBe("Turn failed");
    expect(sanitizeThreadErrorMessage("Select a base branch before sending.")).toBe(
      "Select a base branch before sending.",
    );
  });

  it("drops transport failures from thread surfaces", () => {
    expect(sanitizeThreadErrorMessage("SocketCloseError: 1006")).toBeNull();
    expect(sanitizeThreadErrorMessage("RpcClientDefect: Unknown socket error")).toBeNull();
  });
});
