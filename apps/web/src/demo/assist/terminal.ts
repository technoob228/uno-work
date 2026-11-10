/**
 * Workspace vision (10.11): a terminal that answers in the page, honestly on
 * its own computer — the prompt, `hostname`, `uname`, `ls`, `uptime`, `df -h`
 * say which machine this shell is on. Everything else: "command not found
 * (demo)". One line buffer per terminal.
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { DemoMachine } from "../heavyFixtures";

type Emit = (method: string, value: unknown) => void;

const lines = new Map<string, string>();

function prompt(machine: DemoMachine): string {
  const user = machine.os === "darwin" ? "misha" : "uno";
  const host = machine.os === "darwin" ? "MacBook-Air" : machine.label;
  return `\x1b[32m${user}@${host}\x1b[0m:\x1b[34m~\x1b[0m$ `;
}

function banner(machine: DemoMachine): string {
  const where =
    machine.os === "darwin"
      ? "your MacBook — files and commands stay on this Mac"
      : `${machine.label} — a cloud computer of your workspace`;
  return `\x1b[2mTerminal on ${where}\x1b[0m\r\n`;
}

function run(machine: DemoMachine, command: string): string {
  const mac = machine.os === "darwin";
  switch (command.trim().split(/\s+/)[0]) {
    case "":
      return "";
    case "hostname":
      return mac ? "MacBook-Air.local" : `${machine.label}`;
    case "uname":
      return mac ? "Darwin 25.5.0 arm64" : "Linux 6.8.0-uno x86_64";
    case "whoami":
      return mac ? "misha" : "uno";
    case "ls":
      return mac ? "Desktop  Documents  Downloads  projects" : "projects  exports  .uno";
    case "uptime":
      return mac
        ? " 18:42  up 3 days, 2 users, load 1.92"
        : " 18:42  up 41 days, 1 user, load 0.31";
    case "df":
      return mac
        ? "/dev/disk3s1  460Gi  212Gi  248Gi  47%  /"
        : "/dev/vda1  160G  61G  99G  39%  /";
    case "pwd":
      return machine.home;
    default:
      return `${command.trim().split(/\s+/)[0]}: command not found (demo)`;
  }
}

const now = () => new Date().toISOString();

function key(input: { threadId?: unknown; terminalId?: unknown }) {
  return `${String(input.threadId)}:${String(input.terminalId ?? "default")}`;
}

/** terminal.* requests of a computer; undefined when it isn't one. */
export function answerTerminalRpc(
  machine: DemoMachine,
  tag: string,
  body: Record<string, unknown>,
  emit: Emit,
): unknown {
  const threadId = String(body.threadId ?? "t");
  const terminalId = String(body.terminalId ?? "default");
  const output = (data: string) =>
    setTimeout(
      () =>
        emit(WS_METHODS.subscribeTerminalEvents, {
          type: "output",
          threadId,
          terminalId,
          createdAt: now(),
          data,
        }),
      10,
    );
  switch (tag) {
    case WS_METHODS.terminalOpen:
    case WS_METHODS.terminalRestart:
      lines.set(key(body), "");
      return {
        threadId,
        terminalId,
        cwd: String(body.cwd ?? machine.home),
        worktreePath: null,
        status: "running",
        pid: 4242,
        history: `${banner(machine)}${prompt(machine)}`,
        exitCode: null,
        exitSignal: null,
        updatedAt: now(),
      };
    case WS_METHODS.terminalWrite: {
      const data = String(body.data ?? "");
      let line = lines.get(key(body)) ?? "";
      let echo = "";
      for (const char of data) {
        if (char === "\r" || char === "\n") {
          const result = run(machine, line);
          echo += `\r\n${result ? `${result}\r\n` : ""}${prompt(machine)}`;
          line = "";
        } else if (char === "\x7f") {
          if (line) {
            line = line.slice(0, -1);
            echo += "\b \b";
          }
        } else if (char >= " ") {
          line += char;
          echo += char;
        }
      }
      lines.set(key(body), line);
      if (echo) output(echo);
      return null;
    }
    case WS_METHODS.terminalResize:
    case WS_METHODS.terminalClear:
    case WS_METHODS.terminalClose:
      return null;
    default:
      return undefined;
  }
}
