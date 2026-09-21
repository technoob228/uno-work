/**
 * Monitor: how busy the computer is right now — CPU with the last hour as a
 * sparkline, memory and disk as plain "x of y" bars. Like Activity Monitor's
 * footer, not like Grafana.
 */
import type { UnoComputerMetrics } from "@t3tools/contracts";
import { ActivityIcon } from "lucide-react";
import { useId } from "react";

import { Skeleton } from "../ui/skeleton";
import { formatGb, formatMemory, percent, sparklinePath } from "./computerFormat";
import { Meter, QuietState, SectionCard } from "./computerUi";

const SPARK_W = 280;
const SPARK_H = 56;

export function ComputerMonitorCard({
  metrics,
  loading,
  diskGbFallback,
}: {
  metrics: UnoComputerMetrics | undefined;
  loading: boolean;
  diskGbFallback: number;
}) {
  const gradientId = useId();
  const live = metrics?.availability === "ok";

  return (
    <SectionCard
      title="Monitor"
      icon={<ActivityIcon />}
      action={
        live ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-success" aria-hidden />
            Live
          </span>
        ) : null
      }
    >
      {loading && !metrics ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : !metrics || !live ? (
        <QuietState
          availability={metrics?.availability ?? "error"}
          message={metrics?.message ?? null}
          soon="A live view of how hard your computer is working — processor, memory and disk — is on its way."
          offline="Your computer is asleep, so there's nothing to measure. Wake it up to see it work."
        />
      ) : (
        <MonitorBody metrics={metrics} gradientId={gradientId} diskGbFallback={diskGbFallback} />
      )}
    </SectionCard>
  );
}

function MonitorBody({
  metrics,
  gradientId,
  diskGbFallback,
}: {
  metrics: UnoComputerMetrics;
  gradientId: string;
  diskGbFallback: number;
}) {
  const cpu = Math.round(metrics.cpuPct ?? 0);
  const spark = sparklinePath(metrics.history, SPARK_W, SPARK_H);
  const memPct = percent(metrics.memUsedMb, metrics.memLimitMb);
  const diskTotal = metrics.diskTotalGb ?? diskGbFallback;
  const diskPct = percent(metrics.diskUsedGb, diskTotal);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-muted-foreground">Processor</span>
          <span className="text-2xl font-semibold tabular-nums tracking-tight">
            {cpu}
            <span className="text-sm font-normal text-muted-foreground">%</span>
          </span>
        </div>
        {spark.line ? (
          <svg
            viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
            preserveAspectRatio="none"
            className="mt-1 h-14 w-full text-primary"
            role="img"
            aria-label="Processor use over the last hour"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
                <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d={spark.area} fill={`url(#${gradientId})`} />
            <path
              d={spark.line}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
        <div className="mt-0.5 text-[11px] text-muted-foreground/70">last hour</div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Memory</span>
          <span className="tabular-nums">
            {metrics.memUsedMb !== null ? formatMemory(metrics.memUsedMb) : "—"}
            {metrics.memLimitMb ? (
              <span className="text-muted-foreground"> of {formatMemory(metrics.memLimitMb)}</span>
            ) : null}
          </span>
        </div>
        <Meter value={memPct} />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">Disk</span>
          <span className="tabular-nums">
            {metrics.diskUsedGb !== null ? formatGb(metrics.diskUsedGb) : "—"}
            {diskTotal ? (
              <span className="text-muted-foreground"> of {formatGb(diskTotal)} used</span>
            ) : null}
          </span>
        </div>
        <Meter value={diskPct} />
      </div>
    </div>
  );
}
