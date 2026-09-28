/**
 * This computer, read once for every place that shows it: Home's header chip,
 * the "This computer" widget, the chat header's chip — and, for a cloud
 * computer picked from a laptop, Home's full view.
 *
 * Reads the computer's state and live load, wires power (Sleep and Turn off
 * are confirmed first), Boost, Memory / cores and the economy line, and hands
 * back `dialogs` (the power confirmation and the resize dialog) for the caller
 * to render next to the chip.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { accountTransport } from "../../../account/unoAccount";
import { BoostControl } from "../BoostControl";
import { PowerConfirmDialog, type ComputerLoad } from "../ComputerHero";
import { EconomyLine } from "../EconomyControl";
import { ResizeDialog } from "../ResizeDialog";
import { boostSummaryLine } from "../boostModel";
import { awakeLine, computerPowerState, humanDuration, sizeLine } from "../computerFormat";
import {
  computerMetricsQueryOptions,
  computerPowerMutationOptions,
  computerStateQueryOptions,
  localMetricsQueryOptions,
} from "../computerQueries";
import { LOW_DISK_PCT, LOW_MEMORY_PCT, isSustained } from "../resizeModel";
import type { ResourceLook } from "../resources/resourceModel";
import { useComputerBoost } from "../useComputerBoost";
import type { HomeComputer } from "./ComputerPill";

const PLATFORM_WORD: Record<string, string> = {
  linux: "Linux",
  darwin: "Mac",
  win32: "Windows",
};

export function useHomeComputer({
  environmentId,
  boxId,
  onOpenLook,
}: {
  environmentId: EnvironmentId | null;
  /** A cloud computer picked from a laptop; null = the machine this daemon runs on. */
  boxId: number | null;
  /** "What's using my computer"; only this machine's own daemon reads it. */
  onOpenLook: ((look: ResourceLook) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const thisMachine = boxId === null;

  const stateQuery = useQuery(computerStateQueryOptions(environmentId, boxId));
  const computer = stateQuery.data;
  const box = computer?.box ?? null;
  const power = computerPowerState(box?.status);
  const hasBox = box !== null;
  const computerOn = box ? power === "on" : true;

  const localMetricsQuery = useQuery(localMetricsQueryOptions(environmentId, thisMachine));
  const cloudMetricsQuery = useQuery(
    computerMetricsQueryOptions(environmentId, boxId, hasBox && !thisMachine),
  );
  const powerMutation = useMutation(
    computerPowerMutationOptions(environmentId, boxId, queryClient),
  );
  const [resizeOpen, setResizeOpen] = useState(false);
  const [powerConfirm, setPowerConfirm] = useState<"sleep" | "stop" | null>(null);

  const load: ComputerLoad | null = thisMachine
    ? localMetricsQuery.data
      ? {
          cpuPct: localMetricsQuery.data.cpuPct,
          memUsedMb: localMetricsQuery.data.memUsedMb,
          memTotalMb: localMetricsQuery.data.memTotalMb,
          diskUsedGb: localMetricsQuery.data.diskUsedGb,
          diskTotalGb: localMetricsQuery.data.diskTotalGb,
        }
      : null
    : cloudMetricsQuery.data?.availability === "ok"
      ? {
          cpuPct: cloudMetricsQuery.data.cpuPct,
          memUsedMb: cloudMetricsQuery.data.memUsedMb,
          memTotalMb: cloudMetricsQuery.data.memLimitMb,
          diskUsedGb: cloudMetricsQuery.data.diskUsedGb,
          diskTotalGb: cloudMetricsQuery.data.diskTotalGb ?? box?.diskGb ?? null,
        }
      : null;
  const lowResource = useLowResource(load);

  const local = localMetricsQuery.data;
  const name = box?.name ?? local?.hostname ?? "This computer";
  const subtitle = box
    ? [sizeLine(box), awakeLine(box)].filter(Boolean).join(" · ") ||
      "Your computer in the Uno cloud"
    : local
      ? `${PLATFORM_WORD[local.platform] ?? local.platform} · ${local.cpuCount} cores · awake ${humanDuration(local.uptimeS)}`
      : null;

  const boostControls = useComputerBoost({
    environmentId,
    boxId,
    boost: computer?.linked ? box?.boost : undefined,
    stateUpdatedAt: stateQuery.dataUpdatedAt,
  });
  // Resizing a boosted computer would fight the boost: one at a time.
  const boosting = boostControls !== null && boostControls.state !== "off";
  const canResize = box !== null && computer?.linked === true && !boosting;
  const openResize = canResize ? () => setResizeOpen(true) : undefined;

  const powerControls = box
    ? {
        pendingAction: powerMutation.isPending ? (powerMutation.variables?.action ?? null) : null,
        error: powerMutation.error instanceof Error ? powerMutation.error.message : null,
      }
    : null;

  // The header chip (and the "This computer" widget): the hero, folded.
  const homeComputer: HomeComputer | null =
    stateQuery.isPending || stateQuery.isError
      ? null
      : {
          name,
          subtitle,
          status: box?.status ?? null,
          address: box?.address ?? null,
          load,
          boosted: boosting,
          boost: boostControls ? <BoostControl controls={boostControls} size="xs" /> : null,
          onResize: openResize,
          power: powerControls
            ? {
                ...powerControls,
                onPower: (action) =>
                  action === "sleep" || action === "stop"
                    ? setPowerConfirm(action)
                    : powerMutation.mutate({ action }),
              }
            : null,
          onOpenLook,
          onAllComputers:
            accountTransport() !== "none" ? () => void navigate({ to: "/my-uno" }) : undefined,
          lowResource: box ? lowResource : null,
          // Economy is on by default and good for Uno: a quiet line in the
          // computer menu, not a card on Home (Misha 27.09).
          economyOn: box?.economy?.enabled === true,
          economy: box?.economy ? (
            <EconomyLine environmentId={environmentId} boxId={boxId} />
          ) : null,
          boostSummary: computer?.linked ? boostSummaryLine(box?.boost) : null,
        };

  const dialogs: ReactNode = (
    <>
      <PowerConfirmDialog
        confirm={powerConfirm}
        own={computer?.own ?? false}
        onCancel={() => setPowerConfirm(null)}
        onConfirm={(action) => {
          powerMutation.mutate({ action });
          setPowerConfirm(null);
        }}
      />
      <ResizeDialog
        environmentId={environmentId}
        boxId={boxId}
        open={resizeOpen}
        onOpenChange={setResizeOpen}
      />
    </>
  );

  return {
    stateQuery,
    computer,
    box,
    power,
    computerOn,
    load,
    loadLive: cloudMetricsQuery.isSuccess,
    lowResource,
    name,
    subtitle,
    boostControls,
    boosting,
    openResize,
    powerMutation,
    powerControls,
    homeComputer,
    dialogs,
  };
}

/**
 * "Running low" only when it is steady: the last few readings (a few seconds
 * apart) all over the line — memory > 85 %, disk > 90 %.
 */
function useLowResource(load: ComputerLoad | null): "memory" | "disk" | null {
  const memory = useRef<number[]>([]);
  const disk = useRef<number[]>([]);
  const [low, setLow] = useState<"memory" | "disk" | null>(null);
  const memPct =
    load?.memUsedMb != null && load.memTotalMb ? (load.memUsedMb / load.memTotalMb) * 100 : null;
  const diskPct =
    load?.diskUsedGb != null && load.diskTotalGb
      ? (load.diskUsedGb / load.diskTotalGb) * 100
      : null;
  useEffect(() => {
    if (memPct !== null) memory.current = [...memory.current, memPct].slice(-10);
    if (diskPct !== null) disk.current = [...disk.current, diskPct].slice(-10);
    setLow(
      isSustained(memory.current, LOW_MEMORY_PCT)
        ? "memory"
        : isSustained(disk.current, LOW_DISK_PCT, 2)
          ? "disk"
          : null,
    );
  }, [memPct, diskPct]);
  return low;
}
