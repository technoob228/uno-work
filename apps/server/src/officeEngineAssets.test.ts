import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compressedDirFor,
  compressedOfficeAsset,
  isOfficeAssetCompressible,
  negotiateOfficeEncoding,
  officeEngineServiceWorkerSource,
  officeEngineVersion,
  splitOfficeEngineVersion,
  warmOfficeEngineCompression,
} from "./officeEngineAssets.ts";
import {
  compressStaticBody,
  isHashedStaticAsset,
  isStaticCompressible,
} from "./staticCompression.ts";

describe("splitOfficeEngineVersion", () => {
  it("strips a versioned prefix", () => {
    expect(
      splitOfficeEngineVersion("/office-engine/v/0123456789ab/vendor/sdkjs/word/sdk-all.js"),
    ).toEqual({ version: "0123456789ab", pathname: "/office-engine/vendor/sdkjs/word/sdk-all.js" });
  });

  it.each([
    "/office-engine/vendor/sdkjs/word/sdk-all.js",
    "/office-engine/v/../vendor/x.js",
    "/office-engine/v/ABCDEF012345/vendor/x.js",
    "/office-engine/v/0123/vendor/x.js",
    "/office-engine/v/0123456789ab",
  ])("leaves %s unversioned", (pathname) => {
    expect(splitOfficeEngineVersion(pathname)).toEqual({ version: null, pathname });
  });
});

describe("negotiateOfficeEncoding", () => {
  it("prefers brotli, falls back to gzip, honours q=0", () => {
    expect(negotiateOfficeEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(negotiateOfficeEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateOfficeEncoding("br;q=0, gzip;q=0.5")).toBe("gzip");
    expect(negotiateOfficeEncoding("identity")).toBeNull();
    expect(negotiateOfficeEncoding(undefined)).toBeNull();
  });
});

describe("isOfficeAssetCompressible", () => {
  it("compresses code, wasm and extensionless font files, not images", () => {
    expect(isOfficeAssetCompressible("/e/vendor/sdkjs/word/sdk-all.js", 28_000_000)).toBe(true);
    expect(isOfficeAssetCompressible("/e/vendor/x2t/x2t.wasm", 60_000_000)).toBe(true);
    expect(isOfficeAssetCompressible("/e/vendor/fonts/049", 1_600_000)).toBe(true);
    expect(isOfficeAssetCompressible("/e/vendor/img/icon.png", 50_000)).toBe(false);
    expect(isOfficeAssetCompressible("/e/vendor/a.js", 100)).toBe(false);
  });
});

describe("engine version and compressed copies", () => {
  let root: string;
  let engineDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "office-assets-"));
    engineDir = nodePath.join(root, "office-engine");
    const api = nodePath.join(engineDir, "vendor/web-apps/apps/api/documents/api.js");
    await fs.mkdir(nodePath.dirname(api), { recursive: true });
    await fs.writeFile(api, "window.DocsAPI = {};");
    const wasm = nodePath.join(engineDir, "vendor/sdkjs/common/wasm/x2t/x2t.wasm");
    await fs.mkdir(nodePath.dirname(wasm), { recursive: true });
    await fs.writeFile(wasm, Buffer.alloc(200_000, 7));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("is null without the engine and changes when the package changes", async () => {
    expect(await officeEngineVersion(nodePath.join(root, "missing"))).toBeNull();
    const first = await officeEngineVersion(engineDir);
    expect(first).toMatch(/^[a-f0-9]{12}$/);
    expect(await officeEngineVersion(engineDir)).toBe(first);
    const api = nodePath.join(engineDir, "vendor/web-apps/apps/api/documents/api.js");
    await fs.writeFile(api, "window.DocsAPI = { v: 2 };");
    expect(await officeEngineVersion(engineDir)).not.toBe(first);
  });

  it("makes a brotli copy once, next to the engine, that decompresses to the file", async () => {
    const version = (await officeEngineVersion(engineDir))!;
    const filePath = nodePath.join(engineDir, "vendor/sdkjs/common/wasm/x2t/x2t.wasm");
    const info = await fs.stat(filePath);
    const input = {
      engineDir,
      version,
      filePath,
      size: info.size,
      mtimeMs: info.mtimeMs,
      encoding: "br" as const,
    };
    const [a, b] = await Promise.all([compressedOfficeAsset(input), compressedOfficeAsset(input)]);
    expect(a).toBe(b);
    expect(a).toBe(
      nodePath.join(
        compressedDirFor(engineDir, version),
        "vendor/sdkjs/common/wasm/x2t/x2t.wasm.br",
      ),
    );
    const body = await fs.readFile(a!);
    expect(body.length).toBeLessThan(info.size / 10);
    expect(zlib.brotliDecompressSync(body).equals(await fs.readFile(filePath))).toBe(true);
    const gz = await compressedOfficeAsset({ ...input, encoding: "gzip" });
    expect(zlib.gunzipSync(await fs.readFile(gz!)).length).toBe(info.size);
  });

  it("refuses paths outside the engine", async () => {
    const outside = nodePath.join(root, "secret.txt");
    await fs.writeFile(outside, "x".repeat(5000));
    expect(
      await compressedOfficeAsset({
        engineDir,
        version: "0123456789ab",
        filePath: outside,
        size: 5000,
        mtimeMs: Date.now(),
        encoding: "br",
      }),
    ).toBeNull();
  });

  it("warms the critical files and drops other versions' copies", async () => {
    const stale = nodePath.join(`${engineDir}-compressed`, "aaaaaaaaaaaa");
    await fs.mkdir(stale, { recursive: true });
    await warmOfficeEngineCompression(engineDir, ["br"]);
    const version = (await officeEngineVersion(engineDir))!;
    await expect(fs.stat(stale)).rejects.toThrow();
    const made = await fs.stat(
      nodePath.join(
        compressedDirFor(engineDir, version),
        "vendor/sdkjs/common/wasm/x2t/x2t.wasm.br",
      ),
    );
    expect(made.isFile()).toBe(true);
  });
});

describe("officeEngineServiceWorkerSource", () => {
  it("is valid JavaScript bound to its version's cache", () => {
    const source = officeEngineServiceWorkerSource("0123456789ab");
    expect(() => new Function(source)).not.toThrow();
    expect(source).toContain('var CACHE = "uno-office-engine-0123456789ab";');
    // Only GETs, only same-origin, only inside its own scope.
    expect(source).toContain('request.method !== "GET"');
    expect(source).toContain("url.origin !== self.location.origin");
    expect(source).toContain("self.registration.scope");
  });
});

describe("static app files", () => {
  it("treats only Vite's hashed output as immutable", () => {
    expect(isHashedStaticAsset("/assets/main-EYqxfu69.js")).toBe(true);
    expect(isHashedStaticAsset("/assets/main-BPZGC587.css")).toBe(true);
    expect(isHashedStaticAsset("/index.html")).toBe(false);
    expect(isHashedStaticAsset("/assets/logo.svg")).toBe(false);
    expect(isHashedStaticAsset("/office-share.html")).toBe(false);
  });

  it("compresses text types only", () => {
    expect(isStaticCompressible("text/javascript", 5_000_000)).toBe(true);
    expect(isStaticCompressible("application/json", 4096)).toBe(true);
    expect(isStaticCompressible("image/svg+xml", 4096)).toBe(true);
    expect(isStaticCompressible("image/png", 4096)).toBe(false);
    expect(isStaticCompressible("text/css", 200)).toBe(false);
  });

  it("compresses a body once and round-trips it", async () => {
    const data = new TextEncoder().encode("console.log('uno');\n".repeat(2000));
    const input = { filePath: "/x/main-abcdefgh.js", mtimeMs: 1, data, encoding: "br" as const };
    const first = await compressStaticBody(input);
    const second = await compressStaticBody(input);
    expect(second).toBe(first);
    expect(zlib.brotliDecompressSync(first!).equals(Buffer.from(data))).toBe(true);
  });
});
