/**
 * "Stop cloud agents" on the person's own computer (Settings → Computer →
 * Cloud agents): every command a cloud agent runs here right now is stopped,
 * here, without asking the cloud. They run under the "Connect my computer"
 * helper (`uno-connect`), each in its own process group (helper
 * `proc_unix.go`): the groups of the helper's children get SIGTERM, then
 * SIGKILL after a grace.
 *
 * The switch going off (hostLogic `setAllow`) keeps new ones out: the cloud
 * side reads it before each call (chatRequests/macSide.ts).
 *
 * @module chatRequests/stopCloudAgents
 */
import { execFile } from "node:child_process";

const HELPER = /(^|\/)uno-connect(\.exe)?$/;
const KILL_GRACE_MS = 3_000;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

/** `ps -axo pid=,ppid=,pgid=,comm=` as rows; lines that aren't one are skipped. */
export function parsePs(output: string): ReadonlyArray<ProcessRow> {
  const rows: Array<ProcessRow> = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: match[4]!,
    });
  }
  return rows;
}

/** The process groups the helper started: its children's, never its own. */
export function helperCommandGroups(rows: ReadonlyArray<ProcessRow>): ReadonlyArray<number> {
  const helpers = rows.filter((row) => HELPER.test(row.command));
  const helperPids = new Set(helpers.map((row) => row.pid));
  const helperGroups = new Set(helpers.map((row) => row.pgid));
  const groups = new Set<number>();
  for (const row of rows) {
    if (!helperPids.has(row.ppid) || HELPER.test(row.command)) continue;
    if (row.pgid <= 1 || helperGroups.has(row.pgid)) continue;
    groups.add(row.pgid);
  }
  return [...groups];
}

const listProcesses = () =>
  new Promise<string>((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,comm="],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });

const signalGroup = (pgid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
};

/** Stops them; how many groups got the signal. Windows: nothing to do this way (0). */
export async function stopCloudAgentCommands(
  options: {
    readonly list?: () => Promise<string>;
    readonly signal?: (pgid: number, signal: NodeJS.Signals) => boolean;
    readonly graceMs?: number;
  } = {},
): Promise<number> {
  if (process.platform === "win32" && options.list === undefined) return 0;
  const list = options.list ?? listProcesses;
  const send = options.signal ?? signalGroup;
  const groups = helperCommandGroups(parsePs(await list()));
  const stopped = groups.filter((pgid) => send(pgid, "SIGTERM"));
  if (stopped.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.graceMs ?? KILL_GRACE_MS));
    const left = new Set(helperCommandGroups(parsePs(await list())));
    for (const pgid of stopped) if (left.has(pgid)) send(pgid, "SIGKILL");
  }
  return stopped.length;
}
