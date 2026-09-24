/**
 * Can this machine's Hermes talk to HTTP MCP servers?
 *
 * Hermes gates its HTTP MCP client on `mcp.client.streamable_http
 * .streamablehttp_client`, which mcp 2.x removed. A Hermes installed with an
 * open `--with "mcp>=1.9"` (our installer and the Work image until 0.0.84)
 * got mcp 2.x and runs without any HTTP MCP server — the Uno assistant then
 * has no `uno-manager` tools and improvises. `hermes acp --version` can't
 * tell; this asks Hermes' own Python.
 *
 * `hermes` is a uv tool entry point: a script whose shebang is the tool's
 * venv interpreter.
 *
 * @module provider/setup/hermesMcpProbe
 */
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import * as nodePath from "node:path";

export type HermesMcpProbeResult = "ok" | "broken" | "unknown";

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_SCRIPT = "from mcp.client.streamable_http import streamablehttp_client";

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `hermes` (or an absolute path) → its file, looking through PATH. */
export async function resolveOnPath(
  command: string,
  pathValue: string | undefined,
): Promise<string | null> {
  if (command.includes("/")) return (await isExecutable(command)) ? command : null;
  for (const dir of (pathValue ?? "").split(nodePath.delimiter)) {
    if (!dir) continue;
    const candidate = nodePath.join(dir, command);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** The interpreter of a script's `#!` line, when it is a python. */
export function pythonFromShebang(firstLine: string): string | null {
  const match = /^#!\s*(\S+)/.exec(firstLine);
  const interpreter = match?.[1];
  if (!interpreter) return null;
  return /\/python[\d.]*$/.test(interpreter) ? interpreter : null;
}

async function readFirstLine(file: string): Promise<string> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
  } finally {
    await handle.close();
  }
}

function runPython(python: string, env: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(python, ["-c", PROBE_SCRIPT], { env, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

export async function probeHermesMcpHttp(input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<HermesMcpProbeResult> {
  try {
    const found = await resolveOnPath(input.binaryPath, input.env.PATH);
    if (found === null) return "unknown";
    const python = pythonFromShebang(await readFirstLine(await realpath(found)));
    if (python === null) return "unknown";
    const code = await runPython(python, input.env);
    if (code === null) return "unknown";
    return code === 0 ? "ok" : "broken";
  } catch {
    return "unknown";
  }
}
