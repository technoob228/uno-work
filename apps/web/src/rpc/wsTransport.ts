import {
  Cause,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  Scope,
  Stream,
} from "effect";
import { RpcClient } from "effect/unstable/rpc";

import { ClientTracingLive } from "../observability/clientTracing";
import { clearAllTrackedRpcRequests } from "./requestLatencyState";
import {
  createWsRpcProtocolLayer,
  makeWsRpcProtocolClient,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolClient,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol";
import {
  isTransportConnectionErrorMessage,
  isTransportInterruptErrorMessage,
  TransportConnectionLostError,
} from "./transportError";

interface SubscribeOptions {
  readonly retryDelay?: Duration.Input;
  readonly onResubscribe?: () => void;
  readonly tag?: string;
}

interface RequestOptions {
  readonly timeout?: Option.Option<Duration.Input>;
}

export interface WsTransportOptions {
  /**
   * Called after each connection attempt that dies before reaching open (or
   * whose socket url cannot be issued at all), with the number of consecutive
   * failures so far. Resets to zero once a session opens. Gives the owner a
   * hook to escalate beyond transport-level recovery (e.g. respawn an ssh
   * tunnel) once WS-level reconnects are clearly not enough.
   */
  readonly onRecoveryFailed?: (consecutiveFailures: number) => void;
}

const DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS = Duration.millis(250);
const AUTO_RECOVERY_DEBOUNCE_MS = 5_000;
const MAX_UNHEALTHY_SUBSCRIPTION_RETRY_DELAY_MS = 5_000;
const NOOP: () => void = () => undefined;

/**
 * While the connection is healthy a failed stream retries at its base cadence
 * (the failure is request-shaped, not connection-shaped). Once the transport
 * knows the connection is down, retries back off exponentially so a dead
 * environment does not spin every subscription at 4 attempts/second.
 */
export function getSubscriptionRetryDelayMs(
  baseDelayMs: number,
  failureStreak: number,
  connectionHealthy: boolean,
): number {
  if (connectionHealthy || failureStreak <= 1) {
    return baseDelayMs;
  }
  const exponent = Math.min(failureStreak - 1, 6);
  return Math.min(baseDelayMs * 2 ** exponent, MAX_UNHEALTHY_SUBSCRIPTION_RETRY_DELAY_MS);
}

interface TransportSession {
  readonly clientPromise: Promise<WsRpcProtocolClient>;
  readonly clientScope: Scope.Closeable;
  readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
}

interface StreamRequestStartInfo {
  readonly id: string;
  readonly tag: string;
  readonly stream: boolean;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

export class WsTransport {
  private readonly url: WsRpcProtocolSocketUrlProvider;
  private readonly lifecycleHandlers: WsProtocolLifecycleHandlers | undefined;
  private readonly options: WsTransportOptions | undefined;
  private disposed = false;
  private hasReportedTransportDisconnect = false;
  private intentionalCloseDepth = 0;
  private connectionHealthy = true;
  private autoRecovery: Promise<void> | null = null;
  private lastAutoRecoveryStartedAt = 0;
  private consecutiveRecoveryFailures = 0;
  private reconnectChain: Promise<void> = Promise.resolve();
  private nextSessionId = 0;
  private activeSessionId = 0;
  private session: TransportSession;
  private lastHeartbeatPongAt = 0;
  private readonly streamRequestStartListeners = new Set<(info: StreamRequestStartInfo) => void>();

  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
    options?: WsTransportOptions,
  ) {
    this.url = url;
    this.lifecycleHandlers = lifecycleHandlers;
    this.options = options;
    this.session = this.createSession();
  }

  async request<TSuccess>(
    execute: (client: WsRpcProtocolClient) => Effect.Effect<TSuccess, Error, never>,
    _options?: RequestOptions,
  ): Promise<TSuccess> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.recoverBeforeRequest();
    const session = this.session;
    const client = await session.clientPromise;
    try {
      return await session.runtime.runPromise(Effect.suspend(() => execute(client)));
    } catch (error) {
      throw this.mapRequestError(error, session);
    }
  }

  async requestStream<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
  ): Promise<void> {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    await this.recoverBeforeRequest();
    const session = this.session;
    const client = await session.clientPromise;
    try {
      await session.runtime.runPromise(
        Stream.runForEach(connect(client), (value) =>
          Effect.sync(() => {
            try {
              listener(value);
            } catch {
              // Swallow listener errors so the stream can finish cleanly.
            }
          }),
        ),
      );
    } catch (error) {
      throw this.mapRequestError(error, session);
    }
  }

  subscribe<TValue>(
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    options?: SubscribeOptions,
  ): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    let active = true;
    let hasReceivedValue = false;
    let transportFailureStreak = 0;
    const retryDelayMs = Duration.toMillis(
      Duration.fromInputUnsafe(options?.retryDelay ?? DEFAULT_SUBSCRIPTION_RETRY_DELAY_MS),
    );
    let cancelCurrentStream: () => void = NOOP;

    void (async () => {
      for (;;) {
        if (!active || this.disposed) {
          return;
        }

        const session = this.session;
        try {
          const runningStream = this.runStreamOnSession(
            session,
            connect,
            listener,
            {
              ...(options?.tag === undefined ? {} : { tag: options.tag }),
              ...(hasReceivedValue
                ? {
                    onStarted: () => {
                      try {
                        options?.onResubscribe?.();
                      } catch {
                        // Swallow reconnect hook errors so the stream can recover.
                      }
                    },
                  }
                : {}),
            },
            () => active,
            () => {
              this.hasReportedTransportDisconnect = false;
              hasReceivedValue = true;
              transportFailureStreak = 0;
            },
          );
          cancelCurrentStream = runningStream.cancel;
          await runningStream.completed;
          cancelCurrentStream = NOOP;
          transportFailureStreak = 0;
        } catch (error) {
          cancelCurrentStream = NOOP;
          if (!active || this.disposed) {
            return;
          }

          if (session !== this.session) {
            continue;
          }

          const formattedError = formatErrorMessage(error);
          if (!isTransportConnectionErrorMessage(formattedError)) {
            console.warn("WebSocket RPC subscription failed", {
              error: formattedError,
            });
            return;
          }

          if (!this.hasReportedTransportDisconnect) {
            console.warn("WebSocket RPC subscription disconnected", {
              error: formattedError,
            });
          }
          this.hasReportedTransportDisconnect = true;
          transportFailureStreak += 1;
          if (!this.connectionHealthy) {
            // Keep the transport self-healing even after the protocol layer
            // exhausted its internal retry budget; debounced to one reconnect
            // per AUTO_RECOVERY_DEBOUNCE_MS.
            void this.ensureAutoRecovery().catch(() => undefined);
          }
          await sleep(
            getSubscriptionRetryDelayMs(retryDelayMs, transportFailureStreak, this.connectionHealthy),
          );
        }
      }
    })();

    return () => {
      active = false;
      cancelCurrentStream();
    };
  }

  async reconnect() {
    if (this.disposed) {
      throw new Error("Transport disposed");
    }

    const reconnectOperation = this.reconnectChain.then(async () => {
      if (this.disposed) {
        throw new Error("Transport disposed");
      }

      clearAllTrackedRpcRequests();
      this.lastHeartbeatPongAt = 0;
      const previousSession = this.session;
      this.session = this.createSession();
      await this.closeSession(previousSession);
    });

    this.reconnectChain = reconnectOperation.catch(() => undefined);
    await reconnectOperation;
  }

  isHeartbeatFresh(maxAgeMs = 15_000): boolean {
    return this.lastHeartbeatPongAt > 0 && Date.now() - this.lastHeartbeatPongAt <= maxAgeMs;
  }

  async dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await this.closeSession(this.session);
  }

  /**
   * When the socket is known dead before a request is written, reconnecting
   * first is idempotency-safe: the request has not reached the server yet, so
   * it is simply issued on the fresh session once the reconnect settles.
   */
  private async recoverBeforeRequest(): Promise<void> {
    if (this.connectionHealthy) {
      return;
    }
    await this.ensureAutoRecovery().catch(() => undefined);
  }

  /**
   * Starts (or joins) a single transport-level reconnect. Debounced so bursts
   * of failing requests and repeated sends against a dead server do not churn
   * one session per call.
   */
  private ensureAutoRecovery(): Promise<void> {
    if (this.autoRecovery) {
      return this.autoRecovery;
    }
    if (Date.now() - this.lastAutoRecoveryStartedAt < AUTO_RECOVERY_DEBOUNCE_MS) {
      return Promise.resolve();
    }
    this.lastAutoRecoveryStartedAt = Date.now();
    const recovery = this.reconnect().finally(() => {
      if (this.autoRecovery === recovery) {
        this.autoRecovery = null;
      }
    });
    this.autoRecovery = recovery;
    return recovery;
  }

  /**
   * Requests must never surface raw socket defects (`RpcClientDefect: Unknown
   * socket error` and friends). Connection-shaped failures become the typed
   * TransportConnectionLostError and kick off an automatic reconnect; requests
   * interrupted because the session was replaced underneath them map the same
   * way. Everything else (application errors) passes through untouched.
   */
  private mapRequestError(error: unknown, session: TransportSession): unknown {
    const message = formatErrorMessage(error);
    if (isTransportConnectionErrorMessage(message)) {
      if (!this.disposed && session === this.session) {
        this.connectionHealthy = false;
        void this.ensureAutoRecovery().catch(() => undefined);
      }
      return new TransportConnectionLostError(error);
    }
    const interruptedBySessionTeardown = this.disposed || session !== this.session;
    if (interruptedBySessionTeardown && isTransportInterruptErrorMessage(message)) {
      return new TransportConnectionLostError(error);
    }
    return error;
  }

  private closeSession(session: TransportSession) {
    this.intentionalCloseDepth += 1;
    return session.runtime.runPromise(Scope.close(session.clientScope, Exit.void)).finally(() => {
      this.intentionalCloseDepth -= 1;
      session.runtime.dispose();
    });
  }

  /**
   * Consecutive-failure accounting for the escalation hook: a failure is a
   * connection attempt that dies before ever opening (or whose socket url
   * cannot be issued). Guarded per attempt so error+close on the same socket
   * counts once; any successful open resets the streak.
   */
  private noteRecoveryFailure(): void {
    this.consecutiveRecoveryFailures += 1;
    try {
      this.options?.onRecoveryFailed?.(this.consecutiveRecoveryFailures);
    } catch {
      // Escalation listeners must never break transport recovery.
    }
  }

  private createSession(): TransportSession {
    const sessionId = this.nextSessionId + 1;
    this.nextSessionId = sessionId;
    this.activeSessionId = sessionId;
    this.connectionHealthy = true;
    let attemptOpened = false;
    let attemptFailureNoted = false;
    const noteAttemptFailure = () => {
      if (attemptOpened || attemptFailureNoted) {
        return;
      }
      if (this.disposed || this.activeSessionId !== sessionId) {
        return;
      }
      attemptFailureNoted = true;
      this.noteRecoveryFailure();
    };
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        createWsRpcProtocolLayer(this.url, {
          ...this.lifecycleHandlers,
          isActive: () => !this.disposed && this.activeSessionId === sessionId,
          isCloseIntentional: () =>
            this.disposed ||
            this.intentionalCloseDepth > 0 ||
            this.lifecycleHandlers?.isCloseIntentional?.() === true,
          onAttempt: (socketUrl) => {
            attemptOpened = false;
            attemptFailureNoted = false;
            this.lifecycleHandlers?.onAttempt?.(socketUrl);
          },
          onOpen: () => {
            this.connectionHealthy = true;
            attemptOpened = true;
            this.consecutiveRecoveryFailures = 0;
            this.lifecycleHandlers?.onOpen?.();
          },
          onError: (message) => {
            this.connectionHealthy = false;
            noteAttemptFailure();
            this.lifecycleHandlers?.onError?.(message);
          },
          onClose: (details, context) => {
            if (!context.intentional) {
              this.connectionHealthy = false;
              noteAttemptFailure();
            }
            this.lifecycleHandlers?.onClose?.(details, context);
          },
          onHeartbeatPong: () => {
            this.lastHeartbeatPongAt = Date.now();
            this.lifecycleHandlers?.onHeartbeatPong?.();
          },
          onRequestStart: (info) => {
            this.lifecycleHandlers?.onRequestStart?.(info);
            if (!info.stream) {
              return;
            }
            for (const listener of this.streamRequestStartListeners) {
              listener(info);
            }
          },
        }),
        ClientTracingLive,
      ),
    );
    const clientScope = runtime.runSync(Scope.make());
    const clientPromise = runtime.runPromise(Scope.provide(clientScope)(makeWsRpcProtocolClient));
    // A client that cannot even be constructed (e.g. the socket url provider
    // rejects because a dead tunnel cannot issue a ws token) counts as a
    // failed attempt for the escalation hook.
    clientPromise.catch(() => noteAttemptFailure());
    return {
      runtime,
      clientScope,
      clientPromise,
    };
  }

  private runStreamOnSession<TValue>(
    session: TransportSession,
    connect: (client: WsRpcProtocolClient) => Stream.Stream<TValue, Error, never>,
    listener: (value: TValue) => void,
    requestStart: {
      readonly tag?: string;
      readonly onStarted?: () => void;
    },
    isActive: () => boolean,
    markValueReceived: () => void,
  ): {
    readonly cancel: () => void;
    readonly completed: Promise<void>;
  } {
    let resolveCompleted!: () => void;
    let rejectCompleted!: (error: unknown) => void;
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve;
      rejectCompleted = reject;
    });
    let requestStartListener: ((info: StreamRequestStartInfo) => void) | null = null;
    if (requestStart.onStarted) {
      requestStartListener = (info) => {
        if (!isActive() || !info.stream) {
          return;
        }
        if (requestStart.tag !== undefined && info.tag !== requestStart.tag) {
          return;
        }
        requestStart.onStarted?.();
        if (requestStartListener) {
          this.streamRequestStartListeners.delete(requestStartListener);
          requestStartListener = null;
        }
      };
      this.streamRequestStartListeners.add(requestStartListener);
    }
    const cancel = session.runtime.runCallback(
      Effect.promise(() => session.clientPromise).pipe(
        Effect.flatMap((client) =>
          Stream.runForEach(connect(client), (value) =>
            Effect.sync(() => {
              if (!isActive()) {
                return;
              }

              markValueReceived();
              try {
                listener(value);
              } catch {
                // Swallow listener errors so the stream stays live.
              }
            }),
          ),
        ),
      ),
      {
        onExit: (exit) => {
          if (requestStartListener) {
            this.streamRequestStartListeners.delete(requestStartListener);
            requestStartListener = null;
          }
          if (Exit.isSuccess(exit)) {
            resolveCompleted();
            return;
          }

          rejectCompleted(Cause.squash(exit.cause));
        },
      },
    );

    return {
      cancel,
      completed,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
