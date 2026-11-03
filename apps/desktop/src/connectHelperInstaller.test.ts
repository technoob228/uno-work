import * as Crypto from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  type ConnectHelperDeps,
  helperAssetName,
  helperPlatform,
  installConnectHelper,
  isTrustedUnoUrl,
  parseInstallScript,
  publishedSum,
  readConnectHelperState,
} from "./connectHelperInstaller.ts";

const BINARY = new TextEncoder().encode("#!fake uno-connect");
const SUM = Crypto.createHash("sha256").update(BINARY).digest("hex");
const SCRIPT = [
  "#!/bin/sh",
  "CODE='7KQ2M9XD'",
  "API='https://getuno.xyz'",
  "DOWNLOAD='https://getuno.xyz/cli/connect'",
  "main",
].join("\n");

function deps(overrides: Partial<ConnectHelperDeps> = {}) {
  const written: Array<{ path: string; bytes: Uint8Array }> = [];
  const runs: Array<{ file: string; args: ReadonlyArray<string> }> = [];
  const base: ConnectHelperDeps = {
    platform: "darwin",
    arch: "arm64",
    homeDir: "/Users/misha",
    isRoot: false,
    fetchText: vi.fn(async (url: string) => {
      if (url.endsWith("/SHA256SUMS")) return `${SUM}  uno-connect-darwin-arm64\nabc  other\n`;
      if (url.startsWith("https://app.uno4.work/c/")) return SCRIPT;
      throw new Error(`unexpected ${url}`);
    }),
    fetchBytes: vi.fn(async () => BINARY),
    readFile: vi.fn(async () => null),
    mkdirPrivate: vi.fn(async () => undefined),
    writeExecutable: vi.fn(async (path: string, bytes: Uint8Array) => {
      written.push({ path, bytes });
    }),
    run: vi.fn(async (file: string, args: ReadonlyArray<string>) => {
      runs.push({ file, args });
      return { code: 0, output: "Connected. You can close this window." };
    }),
    ...overrides,
  };
  return { deps: base, written, runs };
}

const input = { url: "https://app.uno4.work/c/7KQ2M9XD", code: "7KQ2M9XD" };

describe("installConnectHelper", () => {
  it("reads the console from the script, checks the sum, installs and pairs", async () => {
    const { deps: d, written, runs } = deps();
    await expect(installConnectHelper(d, input)).resolves.toEqual({ ok: true });
    expect(d.fetchBytes).toHaveBeenCalledWith(
      "https://getuno.xyz/cli/connect/uno-connect-darwin-arm64",
    );
    expect(written).toEqual([{ path: "/Users/misha/.uno-connect/uno-connect", bytes: BINARY }]);
    expect(runs).toEqual([
      {
        file: "/Users/misha/.uno-connect/uno-connect",
        args: ["pair", "--code", "7KQ2M9XD", "--api", "https://getuno.xyz"],
      },
    ]);
  });

  it("uses api and download from the pairing without fetching the script", async () => {
    const { deps: d } = deps();
    await installConnectHelper(d, {
      ...input,
      api: "https://getuno.xyz",
      download: "https://getuno.xyz/cli/connect/",
    });
    expect(d.fetchText).toHaveBeenCalledTimes(1);
    expect(d.fetchText).toHaveBeenCalledWith("https://getuno.xyz/cli/connect/SHA256SUMS");
  });

  it("refuses a damaged download and installs nothing", async () => {
    const {
      deps: d,
      written,
      runs,
    } = deps({
      fetchBytes: vi.fn(async () => new TextEncoder().encode("tampered")),
    });
    await expect(installConnectHelper(d, input)).resolves.toMatchObject({
      ok: false,
      step: "checksum",
    });
    expect(written).toEqual([]);
    expect(runs).toEqual([]);
  });

  it("refuses when no sum is published for this computer", async () => {
    const { deps: d } = deps({ platform: "linux", arch: "x64" });
    await expect(installConnectHelper(d, input)).resolves.toMatchObject({ step: "checksum" });
  });

  it("refuses foreign or plain-http addresses", async () => {
    const { deps: d } = deps();
    await expect(
      installConnectHelper(d, { ...input, url: "https://evil.example/c/7KQ2M9XD" }),
    ).resolves.toMatchObject({ step: "script" });
    await expect(
      installConnectHelper(d, {
        ...input,
        api: "http://getuno.xyz",
        download: "https://getuno.xyz/cli/connect",
      }),
    ).resolves.toMatchObject({ step: "script" });
    const { deps: d2 } = deps({
      fetchText: vi.fn(async () =>
        SCRIPT.replace("https://getuno.xyz/cli/connect", "https://getuno.xyz.evil.example/x"),
      ),
    });
    await expect(installConnectHelper(d2, input)).resolves.toMatchObject({ step: "script" });
  });

  it("never runs as root and rejects a strange code", async () => {
    expect(await installConnectHelper(deps({ isRoot: true }).deps, input)).toMatchObject({
      step: "root",
    });
    expect(
      await installConnectHelper(deps().deps, { ...input, code: "7KQ2; rm -rf ~" }),
    ).toMatchObject({ step: "code" });
  });

  it("passes the helper's own words on a failed pairing", async () => {
    const { deps: d } = deps({
      run: vi.fn(async () => ({
        code: 1,
        output:
          "Uno Connect: This command has expired or was already used. Get a new one in Uno Work.",
      })),
    });
    await expect(installConnectHelper(d, input)).resolves.toEqual({
      ok: false,
      step: "pair",
      message: "This command has expired or was already used. Get a new one in Uno Work.",
    });
  });

  it("installs on Windows into LocalAppData as uno-connect.exe", async () => {
    const { deps: d, written } = deps({
      platform: "win32",
      arch: "x64",
      localAppData: "C:\\Users\\m\\AppData\\Local",
      fetchText: vi.fn(async (url: string) =>
        url.endsWith("SHA256SUMS") ? `${SUM}  uno-connect-windows-amd64.exe\n` : SCRIPT,
      ),
    });
    await expect(installConnectHelper(d, input)).resolves.toEqual({ ok: true });
    expect(written[0]?.path).toBe("C:\\Users\\m\\AppData\\Local\\UnoConnect\\uno-connect.exe");
  });
});

describe("helpers", () => {
  it("knows Uno's hosts", () => {
    expect(isTrustedUnoUrl("https://app.uno4.work/c/X")).toBe(true);
    expect(isTrustedUnoUrl("https://getuno.xyz")).toBe(true);
    expect(isTrustedUnoUrl("https://getuno.xyz.evil.com")).toBe(false);
    expect(isTrustedUnoUrl("https://user@getuno.xyz")).toBe(false);
    expect(isTrustedUnoUrl("http://getuno.xyz")).toBe(false);
  });

  it("parses the script, the sums and the platform", () => {
    expect(parseInstallScript(SCRIPT)).toEqual({
      api: "https://getuno.xyz",
      download: "https://getuno.xyz/cli/connect",
    });
    expect(parseInstallScript("API='x'")).toBeNull();
    expect(publishedSum(`${SUM} *uno-connect-linux-amd64`, "uno-connect-linux-amd64")).toBe(SUM);
    expect(helperPlatform("darwin", "x64")).toEqual({ os: "darwin", arch: "amd64" });
    expect(helperPlatform("freebsd", "x64")).toBeNull();
    expect(helperAssetName("windows", "arm64")).toBe("uno-connect-windows-arm64.exe");
  });

  it("reads only the id and the name from the helper's config", async () => {
    const state = await readConnectHelperState({
      platform: "darwin",
      arch: "arm64",
      homeDir: "/Users/misha",
      readFile: async (path) =>
        path === "/Users/misha/.uno-connect/config.json"
          ? JSON.stringify({ computerId: 41, token: "uno_cmp_secret", name: "MacBook" })
          : null,
    });
    expect(state).toEqual({ installed: true, computerId: "41", name: "MacBook" });
    expect(
      await readConnectHelperState({
        platform: "darwin",
        arch: "arm64",
        homeDir: "/x",
        readFile: async () => null,
      }),
    ).toEqual({ installed: false, computerId: null, name: null });
  });
});
