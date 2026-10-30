/**
 * Multi-computer variants (28.10): each computer's live load as its daemon
 * would read it (`uno.computer.localMetrics`). The numbers move a little with
 * time so a bar or a sparkline visibly lives; `load=busy` makes uno-work
 * nearly full (CPU ~90 %, disk 151 of 160 GB) for the "something is wrong
 * there" state.
 */
import type { DemoMachine } from "../heavyFixtures";
import { WORLD } from "./world";

const MB_PER_GB = 1024;

interface Shape {
  cpu: number;
  cpuSwing: number;
  memGb: number;
  memTotalGb: number;
  diskGb: number;
  diskTotalGb: number;
  cores: number;
  uptimeS: number;
}

function shapeOf(machine: DemoMachine): Shape {
  const busy = WORLD.load === "busy";
  switch (machine.key) {
    case "work":
      return busy
        ? {
            cpu: 88,
            cpuSwing: 8,
            memGb: 14.6,
            memTotalGb: 16,
            diskGb: 151,
            diskTotalGb: 160,
            cores: 8,
            uptimeS: 86_400 + 3_600 * 5,
          }
        : {
            cpu: 34,
            cpuSwing: 18,
            memGb: 9.6,
            memTotalGb: 16,
            diskGb: 74,
            diskTotalGb: 160,
            cores: 8,
            uptimeS: 86_400 + 3_600 * 5,
          };
    case "mac":
      return {
        cpu: 22,
        cpuSwing: 12,
        memGb: 11.8,
        memTotalGb: 16,
        diskGb: 388,
        diskTotalGb: 512,
        cores: 10,
        uptimeS: 86_400 * 6,
      };
    default:
      return {
        cpu: 6,
        cpuSwing: 4,
        memGb: 1.1,
        memTotalGb: 4,
        diskGb: 6,
        diskTotalGb: 20,
        cores: 2,
        uptimeS: 60,
      };
  }
}

/** A slow wobble per computer (different phase), plus a little noise. */
function wobble(key: string, swing: number): number {
  const phase = key === "work" ? 0 : key === "mac" ? 2.1 : 4.2;
  const t = Date.now() / 9_000;
  return swing * Math.sin(t + phase) + (Math.random() - 0.5) * swing * 0.4;
}

export function demoMetrics(machine: DemoMachine) {
  const shape = shapeOf(machine);
  const cpu = Math.max(
    1,
    Math.min(99, Math.round(shape.cpu + wobble(machine.key, shape.cpuSwing))),
  );
  const mem = shape.memGb + wobble(`${machine.key}-mem`, 0.3);
  return {
    hostname: machine.label,
    platform: machine.os,
    cpuPct: cpu,
    cpuCount: shape.cores,
    memUsedMb: Math.round(mem * MB_PER_GB),
    memTotalMb: shape.memTotalGb * MB_PER_GB,
    diskUsedGb: shape.diskGb,
    diskTotalGb: shape.diskTotalGb,
    uptimeS: shape.uptimeS,
  };
}
