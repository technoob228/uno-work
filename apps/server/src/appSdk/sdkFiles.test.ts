import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { renderBundle } from "../../scripts/embed-app-sdk.ts";
import { GIT_REMOTE_UNO_LAUNCHER, UNO_CLI_LAUNCHER, installSdkFiles } from "./sdkFiles.ts";
import { unoCliBinDir, withUnoCliOnPath } from "./unoCliPath.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("embedded App SDK", () => {
  it("matches packages/app-sdk and sdk/python (run apps/server/scripts/embed-app-sdk.ts)", () => {
    const expected = renderBundle((file) => readFileSync(path.join(root, file), "utf8"));
    const actual = readFileSync(
      path.join(root, "apps/server/src/appSdk/sdkBundle.generated.ts"),
      "utf8",
    );
    expect(actual).toBe(expected);
  });
});

describe("installSdkFiles", () => {
  const homes: string[] = [];
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "writes the `uno` command executable, and it runs from the bin folder",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "uno-sdk-"));
      homes.push(home);
      await installSdkFiles(home);

      const bin = path.join(unoCliBinDir(home), "uno");
      expect(readFileSync(bin, "utf8")).toBe(UNO_CLI_LAUNCHER);
      expect(statSync(bin).mode & 0o777).toBe(0o755);
      expect(statSync(path.join(home, ".uno/sdk/js/uno-app.mjs")).mode & 0o111).toBe(0);

      // An older copy without the exec bit gets it back on the next start.
      chmodSync(bin, 0o644);
      await installSdkFiles(home);
      expect(statSync(bin).mode & 0o777).toBe(0o755);

      const help = execFileSync(bin, ["help"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      expect(help).toContain("uno drive put <path...>");
    },
  );

  it.skipIf(process.platform === "win32")(
    "writes the git-remote-uno helper next to it, and where the daemon keeps its settings",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "uno-sdk-"));
      homes.push(home);
      await installSdkFiles(home, {
        settingsPath: "/var/lib/uno-work/userdata/settings.json",
        consoleUrl: "https://console.example",
      });

      const helper = path.join(unoCliBinDir(home), "git-remote-uno");
      expect(readFileSync(helper, "utf8")).toBe(GIT_REMOTE_UNO_LAUNCHER);
      expect(statSync(helper).mode & 0o777).toBe(0o755);
      expect(JSON.parse(readFileSync(path.join(home, ".uno/sdk/daemon.json"), "utf8"))).toEqual({
        settingsPath: "/var/lib/uno-work/userdata/settings.json",
        consoleUrl: "https://console.example",
      });

      // git would run it as `git-remote-uno <remote> <url>`: a bad name is refused in words.
      const run = spawnSync(helper, ["origin", "uno::Not Valid"], {
        encoding: "utf8",
        input: "",
        env: { PATH: process.env.PATH ?? "", HOME: home },
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("isn't an Uno project name");
    },
  );
});

describe("withUnoCliOnPath", () => {
  it("puts ~/.uno/sdk/bin first once, and leaves Windows and a missing PATH alone", () => {
    const bin = unoCliBinDir("/home/me");
    const next = withUnoCliOnPath({ PATH: "/usr/bin" }, "/home/me", "linux");
    expect(next.PATH).toBe(`${bin}${path.delimiter}/usr/bin`);
    expect(withUnoCliOnPath(next, "/home/me", "linux")).toBe(next);
    expect(withUnoCliOnPath({ PATH: "/usr/bin" }, "/home/me", "win32").PATH).toBe("/usr/bin");
    expect(withUnoCliOnPath({}, "/home/me", "linux").PATH).toBeUndefined();
  });
});
