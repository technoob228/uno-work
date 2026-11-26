import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AntigravityInstallDeps,
  antigravityManagedRoot,
  installAntigravityCli,
  readActiveAntigravity,
  resolveAntigravityExecutable,
} from "./AntigravityInstallation.ts";

const tempDir = () => mkdtemp(nodePath.join(os.tmpdir(), "agy-install-"));

const executableFile = async (file: string) => {
  await mkdir(nodePath.dirname(file), { recursive: true });
  await writeFile(file, "#!/bin/sh\necho 1.5.16\n");
  await chmod(file, 0o755);
};

describe("which Antigravity a chat runs", () => {
  it("prefers the managed install over agy on PATH, and PATH over the usual places", async () => {
    const home = await tempDir();
    const bin = nodePath.join(home, "bin");
    const env = { PATH: bin, XDG_DATA_HOME: nodePath.join(home, "data") };
    await executableFile(nodePath.join(home, ".local", "bin", "agy"));
    expect(
      await resolveAntigravityExecutable({ binaryPath: "", env, platform: "linux", home }),
    ).toMatchObject({ ok: true, source: expect.stringMatching(/known|path/) });

    await executableFile(nodePath.join(bin, "agy"));
    const onPath = await resolveAntigravityExecutable({
      binaryPath: "",
      env,
      platform: "linux",
      home,
    });
    expect(onPath).toMatchObject({ ok: true });

    const root = antigravityManagedRoot(env, "linux", home);
    await executableFile(nodePath.join(root, "versions", "1.5.16", "antigravity"));
    await writeFile(
      nodePath.join(root, "active.json"),
      JSON.stringify({ version: "1.5.16", executable: "versions/1.5.16/antigravity" }),
    );
    expect(
      await resolveAntigravityExecutable({ binaryPath: "", env, platform: "linux", home }),
    ).toEqual({
      ok: true,
      source: "managed",
      path: nodePath.join(root, "versions", "1.5.16", "antigravity"),
    });
  });

  it("never runs a file outside the managed folder from active.json", async () => {
    const root = await tempDir();
    await executableFile(nodePath.join(root, "..", "elsewhere-agy"));
    await writeFile(
      nodePath.join(root, "active.json"),
      JSON.stringify({ version: "1.5.16", executable: "../elsewhere-agy" }),
    );
    expect(await readActiveAntigravity(root)).toBeUndefined();
  });

  it("says plainly when there is no Antigravity", async () => {
    const home = await tempDir();
    const result = await resolveAntigravityExecutable({
      binaryPath: "",
      env: { PATH: nodePath.join(home, "nothing"), XDG_DATA_HOME: nodePath.join(home, "d") },
      platform: "linux",
      home,
    });
    expect(result.ok).toBe(false);
  });
});

describe("managed install", () => {
  const binary = Buffer.from("fake antigravity binary");
  const archive = Buffer.from("fake tarball bytes");
  const sha512 = (bytes: Buffer) => createHash("sha512").update(bytes).digest("hex");
  const url =
    "https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.16-6815064432214016/linux-x64/cli_linux_x64.tar.gz";

  const deps = async (
    overrides: Partial<AntigravityInstallDeps> & { readonly manifestSha?: string } = {},
  ): Promise<AntigravityInstallDeps & { lines: string[] }> => {
    const root = await tempDir();
    const lines: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const target = String(input);
      if (target.endsWith("/linux_amd64.json")) {
        return new Response(
          JSON.stringify({
            version: "1.5.16",
            url,
            sha512: overrides.manifestSha ?? sha512(archive),
          }),
        );
      }
      if (target === url) return new Response(archive);
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;
    return {
      fetch,
      platform: "linux",
      arch: "x64",
      musl: false,
      root,
      log: (line) => lines.push(line),
      version: async () => "1.5.16\n",
      extract: async (_archive, dir, member) => {
        await writeFile(nodePath.join(dir, member), binary);
      },
      lines,
      ...overrides,
    };
  };

  it("verifies, unpacks and activates Google's current CLI", async () => {
    const d = await deps();
    const result = await installAntigravityCli(d);
    expect(result.version).toBe("1.5.16");
    expect(result.executable).toBe(nodePath.join(d.root, "versions", "1.5.16", "antigravity"));
    expect(await readFile(result.executable)).toEqual(binary);
    expect(await readActiveAntigravity(d.root)).toEqual(result);
    expect(d.lines.some((line) => line.includes("Checksum verified"))).toBe(true);
    // The second run finds it in place.
    expect(await installAntigravityCli(d)).toEqual(result);
  });

  it("installs nothing when the checksum does not match", async () => {
    const d = await deps({ manifestSha: "a".repeat(128) });
    await expect(installAntigravityCli(d)).rejects.toThrow(/checksum/);
    expect(await readActiveAntigravity(d.root)).toBeUndefined();
  });

  it("installs nothing when the CLI reports another version", async () => {
    const d = await deps({ version: async () => "1.4.0\n" });
    await expect(installAntigravityCli(d)).rejects.toThrow(/not 1.5.16/);
    expect(await readActiveAntigravity(d.root)).toBeUndefined();
  });

  it("refuses a computer Google has no build for", async () => {
    const d = await deps({ arch: "ia32" });
    await expect(installAntigravityCli(d)).rejects.toThrow(/no build/);
  });
});
