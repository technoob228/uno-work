const TRANSPORT_ERROR_PATTERNS = [
  /\bSocketCloseError\b/i,
  /\bSocketOpenError\b/i,
  /\bSocketReadError\b/i,
  /\bSocketWriteError\b/i,
  /\bRpcClientDefect\b/i,
  /\bUnknown socket error\b/i,
  /Unable to connect to the T3 server WebSocket\./i,
  /\bping timeout\b/i,
  /Connection to the server was lost\./i,
] as const;

const INTERRUPT_ERROR_PATTERNS = [/\binterrupt/i] as const;

export const TRANSPORT_CONNECTION_LOST_MESSAGE = "Connection to the server was lost. Reconnecting…";

/**
 * Typed replacement for raw socket defects (e.g. `RpcClientDefect: Unknown
 * socket error`) that unary RPC calls hit when the WebSocket dies mid-flight.
 * Its message matches `isTransportConnectionErrorMessage`, so thread error
 * surfaces sanitize it away and rely on the connection toast instead.
 */
export class TransportConnectionLostError extends Error {
  override readonly name = "TransportConnectionLostError";

  constructor(cause?: unknown) {
    super(TRANSPORT_CONNECTION_LOST_MESSAGE, cause === undefined ? undefined : { cause });
  }
}

export function isTransportConnectionErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string") {
    return false;
  }

  const normalizedMessage = message.trim();
  if (normalizedMessage.length === 0) {
    return false;
  }

  return TRANSPORT_ERROR_PATTERNS.some((pattern) => pattern.test(normalizedMessage));
}

/**
 * Matches rejections produced when a session is torn down underneath an
 * in-flight request (fiber interrupts from a concurrent reconnect/dispose).
 */
export function isTransportInterruptErrorMessage(message: string | null | undefined): boolean {
  if (typeof message !== "string" || message.trim().length === 0) {
    return false;
  }
  return INTERRUPT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function sanitizeThreadErrorMessage(message: string | null | undefined): string | null {
  return isTransportConnectionErrorMessage(message) ? null : (message ?? null);
}
