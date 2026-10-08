import { describe, expect, it } from "vitest";

import {
  commandScanEnabled,
  listeningInodes,
  ownServiceCgroup,
  parseProcStat,
  pickWorkCommands,
  type ScannedProc,
} from "./commandScan.ts";

const DAEMON = 819;

function proc(
  pid: number,
  ppid: number,
  comm: string,
  extra: Partial<Pick<ScannedProc, "cmdline" | "app" | "listening">> = {},
): ScannedProc {
  return {
    pid,
    ppid,
    comm,
    cmdline: extra.cmdline ?? comm,
    app: extra.app ?? false,
    listening: extra.listening ?? false,
  };
}

const daemon = proc(DAEMON, 1, "node", { cmdline: "node /opt/uno-work/app/dist/bin.mjs serve" });
const hermes = proc(8144, DAEMON, "hermes", { cmdline: "python /home/unowork/.local/bin/hermes acp" });
const opencode = proc(1165, DAEMON, "opencode", {
  cmdline: "/home/unowork/.unowork/opencode/bin/opencode serve --port=33605",
  listening: true,
});

describe("pickWorkCommands", () => {
  it("an idle computer: the daemon and its harnesses hold nothing", () => {
    expect(pickWorkCommands(DAEMON, [daemon, hermes, opencode])).toEqual([]);
  });

  it("a command of the agent's shell counts (the tree seen on a Work computer)", () => {
    const procs = [
      daemon,
      hermes,
      proc(9685, 8144, "bash", { cmdline: "/usr/bin/bash -c source snap.sh; eval 'sleep 55'" }),
      proc(9689, 9685, "sleep", { cmdline: "sleep 55" }),
    ];
    expect(pickWorkCommands(DAEMON, procs)).toEqual(["sleep"]);
  });

  it("a job started with nohup and left behind (its parent is init now) counts", () => {
    const procs = [daemon, hermes, proc(9900, 1, "python3", { cmdline: "python3 train.py" })];
    expect(pickWorkCommands(DAEMON, procs)).toEqual(["python3"]);
  });

  it("a program running in a Work terminal counts, the empty shell does not", () => {
    const shell = proc(7000, DAEMON, "bash");
    expect(pickWorkCommands(DAEMON, [daemon, shell])).toEqual([]);
    expect(
      pickWorkCommands(DAEMON, [daemon, shell, proc(7001, 7000, "cargo", { cmdline: "cargo build" })]),
    ).toEqual(["cargo"]);
  });

  it("an editor, a pager or tmux left open is not work", () => {
    const shell = proc(7000, DAEMON, "bash");
    const procs = [
      daemon,
      shell,
      proc(7001, 7000, "vim"),
      proc(7002, 7000, "less"),
      proc(7003, 1, "tmux: server"),
      proc(7004, 1, "gpg-agent"),
    ];
    expect(pickWorkCommands(DAEMON, procs)).toEqual([]);
  });

  it("a registered app is not a command, whatever it forks into", () => {
    const procs = [
      daemon,
      proc(5000, DAEMON, "bash", { cmdline: "/bin/bash -lc python bot.py", app: true }),
      proc(5001, 5000, "python", { cmdline: "python bot.py", app: true }),
      proc(5002, 1, "python", { cmdline: "python worker.py", app: true }),
    ];
    expect(pickWorkCommands(DAEMON, procs)).toEqual([]);
  });

  it("a dev server the agent left running is a server, with its launchers", () => {
    const procs = [
      daemon,
      hermes,
      proc(9100, 8144, "bash", { cmdline: "bash -c npm run dev" }),
      proc(9101, 9100, "npm run dev", { cmdline: "npm run dev" }),
      proc(9102, 9101, "sh", { cmdline: "sh -c vite" }),
      proc(9103, 9102, "node", { cmdline: "node node_modules/.bin/vite", listening: true }),
      proc(9104, 9103, "esbuild", { cmdline: "esbuild --service=0.25 --ping" }),
    ];
    expect(pickWorkCommands(DAEMON, procs)).toEqual([]);
  });

  it("a job that only happens to start a server keeps counting", () => {
    const procs = [
      daemon,
      hermes,
      proc(9200, 8144, "bash", { cmdline: "bash -c pytest" }),
      proc(9201, 9200, "pytest", { cmdline: "pytest -x" }),
      proc(9202, 9201, "python", { cmdline: "python -m http.server", listening: true }),
    ];
    expect(pickWorkCommands(DAEMON, procs)).toEqual(["pytest"]);
  });

  it("a harness that listens (opencode serve) does not turn its commands into servers", () => {
    const procs = [
      daemon,
      opencode,
      proc(9300, 1165, "bash", { cmdline: "bash -c ./build.sh" }),
      proc(9301, 9300, "make", { cmdline: "make all" }),
      proc(9302, 9301, "cc1", { cmdline: "cc1 main.c" }),
    ];
    expect(pickWorkCommands(DAEMON, procs)).toEqual(["cc1", "make"]);
  });

  it("language servers, MCP servers and the browser's helpers are plumbing", () => {
    const procs = [
      daemon,
      opencode,
      proc(9400, 1165, "node", { cmdline: "node typescript-language-server --stdio" }),
      proc(9401, 1165, "gopls", { cmdline: "gopls serve" }),
      proc(9402, 8144, "node", { cmdline: "node /usr/lib/node_modules/@acme/mcp-server/index.js" }),
      proc(9403, 8144, "npm exec @mode", {
        cmdline: "npm exec @modelcontextprotocol/server-filesystem /home",
      }),
      proc(9404, 6000, "chrome", { cmdline: "/opt/chrome/chrome --type=renderer --lang=en" }),
    ];
    expect(pickWorkCommands(DAEMON, procs)).toEqual([]);
  });

  it("names are unique, sorted and capped", () => {
    const procs = [daemon, hermes];
    for (const [i, name] of ["g", "f", "e", "d", "c", "b", "a", "a"].entries()) {
      procs.push(proc(9500 + i, 8144, name));
    }
    expect(pickWorkCommands(DAEMON, procs)).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("reading /proc", () => {
  it("parses a stat line with spaces and brackets in the name", () => {
    expect(parseProcStat("9101 (npm run dev) S 9100 9100 9100 0 -1 4194304 1 2 3")).toEqual({
      comm: "npm run dev",
      ppid: 9100,
    });
    expect(parseProcStat("7003 (tmux: server (1)) S 1 7003 7003 0")).toEqual({
      comm: "tmux: server (1)",
      ppid: 1,
    });
  });

  it("skips zombies and broken lines", () => {
    expect(parseProcStat("9102 (sleep) Z 9101 9100 9100 0")).toBeNull();
    expect(parseProcStat("garbage")).toBeNull();
  });

  it("reads only a service cgroup of its own", () => {
    expect(ownServiceCgroup("0::/system.slice/uno-work.service\n")).toBe(
      "/sys/fs/cgroup/system.slice/uno-work.service",
    );
    expect(ownServiceCgroup("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeNull();
    expect(
      ownServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.service\n"),
    ).toBeNull();
    expect(ownServiceCgroup("0::/\n")).toBeNull();
    expect(ownServiceCgroup("12:pids:/foo\n")).toBeNull();
  });

  it("finds listening sockets in /proc/net/tcp", () => {
    const text = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 24680 1 0000000000000000 100 0 0 10 0",
      "   1: 0100007F:8335 0100007F:C3A2 01 00000000:00000000 00:00000000 00000000  1002        0 13579 1 0000000000000000 20 4 30 10 -1",
    ].join("\n");
    expect([...listeningInodes(text)]).toEqual(["24680"]);
  });

  it("has a kill switch", () => {
    expect(commandScanEnabled({})).toBe(true);
    expect(commandScanEnabled({ UNO_WORK_ECONOMY_COMMANDS: "off" })).toBe(false);
  });
});
