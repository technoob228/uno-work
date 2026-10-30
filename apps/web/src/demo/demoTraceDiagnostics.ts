/** The journal as the wire carries it, for the demo's Diagnostics page. */
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export function demoTraceDiagnostics() {
  return {
    traceFilePath: "/home/uno/.t3/logs/server.trace.ndjson",
    scannedFilePaths: ["/home/uno/.t3/logs/server.trace.ndjson"],
    readAt: at(0),
    recordCount: 18_432,
    parseErrorCount: 0,
    firstSpanAt: { _tag: "Some", value: at(600) },
    lastSpanAt: { _tag: "Some", value: at(1) },
    failureCount: 7,
    interruptionCount: 2,
    slowSpanThresholdMs: 1_000,
    slowSpanCount: 41,
    logLevelCounts: { Info: 960, Warning: 12, Error: 3 },
    topSpansByCount: [
      {
        name: "ws.rpc.vcs.status",
        count: 4_210,
        failureCount: 0,
        totalDurationMs: 88_410,
        averageDurationMs: 21,
        maxDurationMs: 640,
      },
      {
        name: "provider.turn",
        count: 96,
        failureCount: 2,
        totalDurationMs: 3_120_000,
        averageDurationMs: 32_500,
        maxDurationMs: 212_000,
      },
    ],
    slowestSpans: [
      {
        name: "provider.turn",
        durationMs: 212_000,
        endedAt: at(14),
        traceId: "demo-trace-1",
        spanId: "demo-span-1",
      },
      {
        name: "git.push",
        durationMs: 4_180,
        endedAt: at(47),
        traceId: "demo-trace-2",
        spanId: "demo-span-2",
      },
    ],
    commonFailures: [
      {
        name: "git.push",
        cause: "remote rejected: protected branch",
        count: 4,
        lastSeenAt: at(47),
        traceId: "demo-trace-2",
        spanId: "demo-span-2",
      },
      {
        name: "provider.turn",
        cause: "Provider stopped: usage limit reached",
        count: 2,
        lastSeenAt: at(190),
        traceId: "demo-trace-3",
        spanId: "demo-span-3",
      },
    ],
    latestFailures: [],
    latestWarningAndErrorLogs: [
      {
        spanName: "git.push",
        level: "Warning",
        message: "push rejected, keeping local commits",
        seenAt: at(47),
        traceId: "demo-trace-2",
        spanId: "demo-span-2",
      },
    ],
    partialFailure: { _tag: "None" },
    error: { _tag: "None" },
  };
}
