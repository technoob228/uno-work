import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const installScript = fileURLToPath(new URL("../../../deploy/install.sh", import.meta.url));
const prepareImageScript = fileURLToPath(
  new URL("../../../deploy/prepare-image.sh", import.meta.url),
);

/** The part of install.sh that decides where the daemon listens, as it ships. */
function bindBlock(): string {
  const script = readFileSync(installScript, "utf8");
  const start = script.indexOf("# >>> bind-address");
  const end = script.indexOf("# <<< bind-address");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe("deploy/install.sh bind address", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uno-install-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const resolveHost = (input: {
    readonly hostname?: string;
    readonly env?: Record<string, string>;
    readonly envFile?: string;
    readonly agent?: boolean;
  }) => {
    const agent = join(dir, "uno-box-agent");
    const envFile = join(dir, "uno-work.env");
    if (input.agent) {
      writeFileSync(agent, "#!/bin/sh\n");
      chmodSync(agent, 0o755);
    }
    if (input.envFile !== undefined) writeFileSync(envFile, input.envFile);
    // `set -euo pipefail` as in the installer: a failure in the block ends the run.
    const script = [
      "set -euo pipefail",
      `hostname() { printf '%s\\n' ${JSON.stringify(input.hostname ?? "vps-123")}; }`,
      bindBlock(),
      'HOST="$(resolve_bind_host)"',
      'printf "%s" "${HOST}"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        UNO_BOX_AGENT_BIN: agent,
        UNO_WORK_ENV_FILE: envFile,
        ...input.env,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };

  it("keeps a machine that isn't a Uno computer on localhost", () => {
    expect(resolveHost({})).toBe("127.0.0.1");
  });

  it("listens on every address on a Uno computer, whatever its name", () => {
    // Box 2531 is called "stage-work": the name proves nothing, the agent does.
    expect(resolveHost({ agent: true, hostname: "stage-work" })).toBe("0.0.0.0");
  });

  it("recognises the machine an image is built on by its name", () => {
    expect(resolveHost({ hostname: "unowork-golden-271" })).toBe("0.0.0.0");
    expect(resolveHost({ hostname: "box-12.uno4.dev" })).toBe("0.0.0.0");
  });

  it("keeps what an installed machine has on an update", () => {
    const envFile = "UNO_WORK_HOST=0.0.0.0\nUNO_WORK_PORT=8080\n";
    expect(resolveHost({ envFile })).toBe("0.0.0.0");
    expect(resolveHost({ envFile: "UNO_WORK_HOST=127.0.0.1\n", agent: true })).toBe("127.0.0.1");
  });

  it("lets the person choose", () => {
    expect(resolveHost({ env: { UNO_WORK_HOST: "10.0.0.5" } })).toBe("10.0.0.5");
    expect(resolveHost({ env: { UNO_WORK_HOST: "127.0.0.1" }, agent: true })).toBe("127.0.0.1");
  });

  it("survives a clean machine with no settings file (pipefail)", () => {
    const script = readFileSync(installScript, "utf8");
    const port = script.match(/PORT="\$\(sed -n 's\/\^UNO_WORK_PORT=[^\n]*/)?.[0];
    expect(port).toContain("|| true");
  });

  it("refuses to snapshot an image that listens on localhost", () => {
    const script = readFileSync(prepareImageScript, "utf8");
    expect(script).toContain("clones would not be reachable");
  });
});
