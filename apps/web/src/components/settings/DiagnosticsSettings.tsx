/**
 * Dev mode's Diagnostics page: this computer's own journal of failures, slow
 * operations and warnings, read from its local trace files. Nothing is sent
 * anywhere. CPU and memory stay in Computer → Resources.
 *
 * @module components/settings/DiagnosticsSettings
 */
import type { EnvironmentId, ServerTraceDiagnosticsResult } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { DateTime, Option } from "effect";
import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { readEnvironmentConnection } from "~/environments/runtime";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
}

function formatTime(value: DateTime.Utc): string {
  return new Date(DateTime.toEpochMillis(value)).toLocaleString();
}

function Stat(props: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "danger" | "warning";
}) {
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <div className="truncate text-[11px] text-muted-foreground">{props.label}</div>
      <div
        className={cn(
          "mt-0.5 truncate font-mono text-lg font-semibold tabular-nums",
          props.tone === "danger" && "text-destructive",
          props.tone === "warning" && "text-warning-foreground",
        )}
      >
        {props.value}
      </div>
    </div>
  );
}

function Table(props: { readonly headers: ReadonlyArray<string>; readonly children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            {props.headers.map((header) => (
              <th key={header} className="whitespace-nowrap px-4 py-2 font-medium sm:px-5">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{props.children}</tbody>
      </table>
    </div>
  );
}

const CELL = "border-t border-border/60 px-4 py-2 align-top sm:px-5";

function Empty(props: { readonly children: ReactNode }) {
  return <p className="px-4 py-4 text-xs text-muted-foreground sm:px-5">{props.children}</p>;
}

function Journal(props: { readonly data: ServerTraceDiagnosticsResult }) {
  const { data } = props;
  const warnings = Object.entries(data.logLevelCounts)
    .filter(([level]) => /warn|error|fatal/i.test(level))
    .reduce((sum, [, count]) => sum + count, 0);
  return (
    <>
      <SettingsSection title="Overview">
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <Stat label="Operations" value={data.recordCount.toLocaleString()} />
          <Stat
            label="Failed"
            value={data.failureCount.toLocaleString()}
            {...(data.failureCount > 0 ? { tone: "danger" as const } : {})}
          />
          <Stat
            label={`Over ${formatDuration(data.slowSpanThresholdMs)}`}
            value={data.slowSpanCount.toLocaleString()}
            {...(data.slowSpanCount > 0 ? { tone: "warning" as const } : {})}
          />
          <Stat
            label="Warnings and errors"
            value={warnings.toLocaleString()}
            {...(warnings > 0 ? { tone: "warning" as const } : {})}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Common failures">
        {data.commonFailures.length === 0 ? (
          <Empty>No failures in the journal.</Empty>
        ) : (
          <Table headers={["Operation", "Cause", "Count", "Last seen"]}>
            {data.commonFailures.map((failure) => (
              <tr key={`${failure.name}:${failure.cause}`}>
                <td className={cn(CELL, "font-mono")}>{failure.name}</td>
                <td className={cn(CELL, "max-w-72 break-words")}>{failure.cause}</td>
                <td className={cn(CELL, "font-mono")}>{failure.count}</td>
                <td className={cn(CELL, "whitespace-nowrap")}>{formatTime(failure.lastSeenAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </SettingsSection>

      <SettingsSection title="Latest warnings and errors">
        {data.latestWarningAndErrorLogs.length === 0 ? (
          <Empty>Nothing logged.</Empty>
        ) : (
          <Table headers={["Level", "Message", "Operation", "When"]}>
            {data.latestWarningAndErrorLogs.map((event) => (
              <tr key={`${event.traceId}:${event.spanId}:${event.message}`}>
                <td className={CELL}>{event.level}</td>
                <td className={cn(CELL, "max-w-72 break-words")}>{event.message}</td>
                <td className={cn(CELL, "font-mono")}>{event.spanName}</td>
                <td className={cn(CELL, "whitespace-nowrap")}>{formatTime(event.seenAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </SettingsSection>

      <SettingsSection title="Slowest operations">
        {data.slowestSpans.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <Table headers={["Operation", "Took", "Ended"]}>
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className={cn(CELL, "font-mono")}>{span.name}</td>
                <td className={cn(CELL, "font-mono")}>{formatDuration(span.durationMs)}</td>
                <td className={cn(CELL, "whitespace-nowrap")}>{formatTime(span.endedAt)}</td>
              </tr>
            ))}
          </Table>
        )}
      </SettingsSection>

      <SettingsSection title="Most frequent operations">
        {data.topSpansByCount.length === 0 ? (
          <Empty>Nothing recorded yet.</Empty>
        ) : (
          <Table headers={["Operation", "Count", "Failed", "Average", "Longest"]}>
            {data.topSpansByCount.map((span) => (
              <tr key={span.name}>
                <td className={cn(CELL, "font-mono")}>{span.name}</td>
                <td className={cn(CELL, "font-mono")}>{span.count}</td>
                <td className={cn(CELL, "font-mono")}>{span.failureCount}</td>
                <td className={cn(CELL, "font-mono")}>{formatDuration(span.averageDurationMs)}</td>
                <td className={cn(CELL, "font-mono")}>{formatDuration(span.maxDurationMs)}</td>
              </tr>
            ))}
          </Table>
        )}
      </SettingsSection>
    </>
  );
}

export function DiagnosticsSettingsPanel(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const query = useQuery({
    queryKey: ["trace-diagnostics", environmentId],
    queryFn: async () => {
      const connection = readEnvironmentConnection(environmentId);
      if (!connection) throw new Error("This computer isn't connected.");
      return connection.client.server.getTraceDiagnostics();
    },
    staleTime: 30_000,
    retry: false,
  });
  const data = query.data ?? null;
  const fileError = data ? Option.getOrNull(data.error) : null;
  const refresh = (
    <Button
      size="icon-xs"
      variant="ghost"
      className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
      onClick={() => void query.refetch()}
      disabled={query.isFetching}
      aria-label="Read the journal again"
    >
      <RefreshCwIcon className={cn("size-3", query.isFetching && "animate-spin")} />
    </Button>
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Journal" headerAction={refresh}>
        <p className="px-4 py-3 text-xs text-muted-foreground sm:px-5">
          {query.isError
            ? "Couldn't read the journal. This computer may need an update."
            : query.isPending
              ? "Reading the journal…"
              : fileError && data?.recordCount === 0
                ? "The journal is empty so far."
                : data
                  ? `Read ${formatTime(data.readAt)}. Stays on this computer.`
                  : ""}
        </p>
      </SettingsSection>
      {data && data.recordCount > 0 ? <Journal data={data} /> : null}
    </SettingsPageContainer>
  );
}
