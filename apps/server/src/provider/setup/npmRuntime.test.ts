import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installManagedNode,
  locateNpm,
  ManagedNodeError,
  managedNodeDownload,
  MANAGED_NODE_VERSION,
  npmCandidateDirs,
  npmMissingHelp,
  withManagedNodeOnPath,
  type DirReader,
} from "./npmRuntime.ts";

const home = "/Users/mikhail";

/** A file system with just these executables (and these folder listings). */
function fakeReader(
  executables: ReadonlyArray<string>,
  listings: Record<string, string[]> = {},
): DirReader {
  return {
    list: async (dir) => listings[dir] ?? [],
    isExecutable: async (file) => executables.includes(file),
  };
}

const withNode = (dir: string) => [`${dir}/npm`, `${dir}/node`];

describe("npmCandidateDirs", () => {
  it("finds Homebrew's npm although the app's PATH has only the system folders", async () => {
    const dirs = await npmCandidateDirs({
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      homeDir: home,
      reader: fakeReader(withNode("/opt/homebrew/bin")),
    });
    expect(dirs).toEqual(["/opt/homebrew/bin"]);
  });

  it("finds nvm's newest Node and fnm's, which only a shell hook puts on PATH", async () => {
    const nvmRoot = `${home}/.nvm/versions/node`;
    const fnmRoot = `${home}/Library/Application Support/fnm/node-versions`;
    const dirs = await npmCandidateDirs({
      env: { PATH: "/usr/bin:/bin" },
      homeDir: home,
      reader: fakeReader(
        [
          ...withNode(`${nvmRoot}/v18.20.0/bin`),
          ...withNode(`${nvmRoot}/v22.11.0/bin`),
          ...withNode(`${fnmRoot}/v20.1.0/installation/bin`),
        ],
        {
          [nvmRoot]: ["v18.20.0", "v22.11.0", "v9.0.0"],
          [fnmRoot]: ["v20.1.0"],
        },
      ),
    });
    expect(dirs).toEqual([
      `${nvmRoot}/v22.11.0/bin`,
      `${nvmRoot}/v18.20.0/bin`,
      `${fnmRoot}/v20.1.0/installation/bin`,
    ]);
  });

  it("keeps PATH order first and Uno Work's own Node last", async () => {
    const dirs = await npmCandidateDirs({
      env: { PATH: `${home}/.volta/bin:/usr/bin` },
      homeDir: home,
      reader: fakeReader([
        ...withNode(`${home}/.uno/node/bin`),
        ...withNode("/usr/local/bin"),
        ...withNode(`${home}/.volta/bin`),
      ]),
    });
    expect(dirs).toEqual([`${home}/.volta/bin`, "/usr/local/bin", `${home}/.uno/node/bin`]);
  });

  it("skips an npm without its node", async () => {
    const dirs = await npmCandidateDirs({
      env: { PATH: "/usr/local/bin" },
      homeDir: home,
      reader: fakeReader(["/usr/local/bin/npm"]),
    });
    expect(dirs).toEqual([]);
  });
});

describe("locateNpm", () => {
  it("takes the first npm that answers, skipping a broken one", async () => {
    const tried: string[] = [];
    const npm = await locateNpm({
      env: { PATH: "/usr/bin" },
      homeDir: home,
      platform: "darwin",
      reader: fakeReader([...withNode("/opt/homebrew/bin"), ...withNode(`${home}/.uno/node/bin`)]),
      probe: async ({ npm, env }) => {
        tried.push(npm);
        expect(env.PATH?.split(":")[0]).toBe(nodePath.dirname(npm));
        return npm.startsWith("/opt/homebrew") ? null : `${home}/.uno/node`;
      },
      isWritable: async () => true,
    });
    expect(tried).toEqual(["/opt/homebrew/bin/npm", `${home}/.uno/node/bin/npm`]);
    expect(npm).toEqual({
      npm: `${home}/.uno/node/bin/npm`,
      binDir: `${home}/.uno/node/bin`,
      globalWritable: true,
      managed: true,
    });
  });

  it("is null on a Mac without Node", async () => {
    const npm = await locateNpm({
      env: { PATH: "/usr/bin:/bin" },
      homeDir: home,
      platform: "darwin",
      reader: fakeReader([]),
      probe: async () => "/should/not/run",
    });
    expect(npm).toBeNull();
  });
});

describe("withManagedNodeOnPath", () => {
  it("puts ~/.uno/node/bin last, once, and leaves Windows alone", () => {
    const env = withManagedNodeOnPath({ PATH: "/opt/homebrew/bin:/usr/bin" }, home, "darwin");
    expect(env.PATH).toBe(`/opt/homebrew/bin:/usr/bin:${home}/.uno/node/bin`);
    expect(withManagedNodeOnPath(env, home, "darwin").PATH).toBe(env.PATH);
    expect(withManagedNodeOnPath({ PATH: "C:\\x" }, home, "win32").PATH).toBe("C:\\x");
  });
});

describe("managedNodeDownload", () => {
  it("knows the official archive for Macs and Linux, not for Windows", () => {
    expect(managedNodeDownload("darwin", "arm64")?.url).toBe(
      `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/node-v${MANAGED_NODE_VERSION}-darwin-arm64.tar.gz`,
    );
    expect(managedNodeDownload("darwin", "x64")?.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(managedNodeDownload("linux", "x64")).not.toBeNull();
    expect(managedNodeDownload("win32", "x64")).toBeNull();
  });
});

describe("installManagedNode", () => {
  let tmpHome: string | undefined;
  afterEach(async () => {
    if (tmpHome) await rm(tmpHome, { recursive: true, force: true });
    tmpHome = undefined;
  });

  const archiveBytes = Buffer.from("not really a tarball");
  const fakeFetch = (bytes: Buffer) =>
    (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;

  it("refuses a download whose checksum does not match, and leaves nothing behind", async () => {
    tmpHome = await mkdtemp(nodePath.join(os.tmpdir(), "t64-home-"));
    const lines: string[] = [];
    const attempt = installManagedNode(
      { homeDir: tmpHome, platform: "darwin", arch: "arm64", fetch: fakeFetch(archiveBytes) },
      (line) => lines.push(line),
    );
    await expect(attempt).rejects.toMatchObject({ reason: "checksum" });
    await expect(stat(nodePath.join(tmpHome, ".uno", "node"))).rejects.toThrow();
    const left = await import("node:fs/promises").then((fs) =>
      fs.readdir(nodePath.join(tmpHome!, ".uno")),
    );
    expect(left).toEqual([]);
  });

  it("says nodejs.org could not be reached when the fetch throws", async () => {
    tmpHome = await mkdtemp(nodePath.join(os.tmpdir(), "t64-home-"));
    const offline = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      installManagedNode(
        { homeDir: tmpHome, platform: "darwin", arch: "arm64", fetch: offline },
        () => {},
      ),
    ).rejects.toMatchObject({ reason: "download" });
  });

  it("unpacks a verified archive into ~/.uno/node, replacing a broken earlier one", async () => {
    tmpHome = await mkdtemp(nodePath.join(os.tmpdir(), "t64-home-"));
    const download = managedNodeDownload("darwin", "arm64")!;
    await mkdir(nodePath.join(tmpHome, ".uno", "node"), { recursive: true });
    await writeFile(nodePath.join(tmpHome, ".uno", "node", "stale"), "x");
    const sha = createHash("sha256").update(archiveBytes).digest("hex");
    // The real hash is pinned; for the test, pretend the archive is the real one.
    const pinned = download.sha256;
    const lines: string[] = [];
    await installManagedNode(
      {
        homeDir: tmpHome,
        platform: "darwin",
        arch: "arm64",
        fetch: fakeFetch(archiveBytes),
        extract: async (archive, dir) => {
          expect(await readFile(archive)).toEqual(archiveBytes);
          await mkdir(nodePath.join(dir, download.folder, "bin"), { recursive: true });
          await writeFile(nodePath.join(dir, download.folder, "bin", "node"), "#!/bin/sh\n");
        },
        checkNode: async () => `v${MANAGED_NODE_VERSION}\n`,
        sha256Override: sha,
      },
      (line) => lines.push(line),
    );
    expect(pinned).not.toBe(sha);
    await expect(stat(nodePath.join(tmpHome, ".uno", "node", "bin", "node"))).resolves.toBeTruthy();
    await expect(stat(nodePath.join(tmpHome, ".uno", "node", "stale"))).rejects.toThrow();
    expect(lines.join("")).toContain("Checksum verified");
    expect(lines.join("")).toContain(`Node.js v${MANAGED_NODE_VERSION} is ready`);
  });
});

describe("npmMissingHelp", () => {
  it("offers Google's Homebrew formula for Gemini CLI on a Mac with brew", () => {
    const help = npmMissingHelp({ driver: "gemini", platform: "darwin", brewAvailable: true });
    expect(help.title).toBe("Gemini CLI needs Node.js, and this Mac doesn't have it yet.");
    expect(help.command).toBe("brew install gemini-cli");
    expect(help.nodeUrl).toBeUndefined();
  });

  it("offers Node via brew plus npm for Grok", () => {
    const help = npmMissingHelp({ driver: "grok", platform: "darwin", brewAvailable: true });
    expect(help.command).toBe("brew install node && npm install -g @xai-official/grok");
  });

  it("without brew, links Node.js and gives the npm command", () => {
    const help = npmMissingHelp({
      driver: "grok",
      platform: "darwin",
      brewAvailable: false,
      managedNodeError: new ManagedNodeError("x", "checksum"),
    });
    expect(help.nodeUrl).toBe("https://nodejs.org/en/download");
    expect(help.command).toBe("npm install -g @xai-official/grok");
    expect(help.detail).toContain("damaged");
    expect(help.title).not.toContain("PATH");
  });
});
