/**
 * Compatibility matrix "fresh web × older daemons" ("one window").
 *
 * With "one window" the account address serves the newest Uno Work interface
 * and computers only answer the API, so a computer may run an older daemon
 * than the interface talking to it. This script proves the pairs still work:
 * it builds the web of this checkout once and, for every daemon in the list,
 * starts that daemon with a clean environment, puts the origin proxy in front
 * (the fresh build + the daemon's API, like the console does) and runs the
 * browser smoke. No console, no database.
 *
 *   bun run compat:matrix                         # current + two newest releases + floor
 *   bun run compat:matrix -- --daemons current,0.0.119,0.0.118,0.0.116,0.0.113
 *   bun run compat:matrix -- --no-build           # reuse apps/web/dist and apps/server/dist
 *
 * Environment (flags win):
 *   COMPAT_DAEMONS            same as --daemons
 *   COMPAT_FLOOR              oldest supported daemon in the default list (0.0.113)
 *   COMPAT_RELEASE_BASE_URL   where release tarballs and SHA256SUMS live
 *   COMPAT_CACHE_DIR          downloaded releases and their dependencies (kept between runs)
 *   COMPAT_OUT                report directory: matrix.md, matrix.json, screenshots, daemon logs
 *   COMPAT_PORT_BASE          daemon on this port, proxy on +1, the daemon's App API on +2 (13921)
 *   COMPAT_CHROMIUM           a Chromium binary to use instead of Playwright's own
 *   COMPAT_WS_HOLD_MS         how long the socket must stay open (30000)
 *
 * Prints the matrix and exits 1 when any cell is ❌.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HTTP_FEATURE_ROUTES, HTTP_FEATURE_SINCE, WsRpcGroup } from "@t3tools/contracts";
import { type Browser, chromium } from "playwright";

import {
  apiRoutesMissingFromBundle,
  apiRoutesOfWebBuild,
  assertPortFree,
  compareVersions,
  CURRENT,
  type DaemonDescriptor,
  DEFAULT_FLOOR_VERSION,
  DEFAULT_RELEASE_BASE_URL,
  defaultDaemonSpecs,
  fetchReleaseSums,
  parseDaemonSpecs,
  type PreparedDaemon,
  prepareRelease,
  type RunningDaemon,
  rpcMethodsMissingFromBundle,
  startDaemon,
  writeJson,
} from "./daemons.ts";
import { judgeHttpRoutes } from "./findings.ts";
import { createOriginProxy, type OriginProxy } from "./originProxy.ts";
import { formatMatrix, type MatrixColumn } from "./report.ts";
import { CHECKS, failed, runSmoke, type SmokeResults } from "./smoke.ts";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const log = (line: string) => console.log(`[compat] ${line}`);

function run(command: string, args: ReadonlyArray<string>, cwd: string, logFile: string) {
  return new Promise<void>((resolveRun, reject) => {
    const out = createWriteStream(logFile, { flags: "a" });
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code} (see ${logFile})`));
    });
  });
}

/** The web's own rule (apps/web environments/httpFeatureSupport.ts): the list, else the version. */
function daemonSupportsHttpFeature(descriptor: DaemonDescriptor, feature: string): boolean {
  const listed = descriptor.capabilities["httpFeatures"];
  if (Array.isArray(listed)) return listed.includes(feature);
  const since = (HTTP_FEATURE_SINCE as Readonly<Record<string, string | undefined>>)[feature];
  return since !== undefined && compareVersions(descriptor.serverVersion, since) >= 0;
}

function allFailed(reason: string): SmokeResults {
  const results = {} as SmokeResults;
  for (const { id } of CHECKS) results[id] = failed(reason);
  return results;
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const webVersion = (
    JSON.parse(readFileSync(join(repoRoot, "apps/web/package.json"), "utf8")) as { version: string }
  ).version;
  const floor = flag("floor") ?? process.env.COMPAT_FLOOR ?? DEFAULT_FLOOR_VERSION;
  const baseUrl = (process.env.COMPAT_RELEASE_BASE_URL ?? DEFAULT_RELEASE_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const cacheDir = resolve(
    process.env.COMPAT_CACHE_DIR ?? join(tmpdir(), "uno-work-compat-matrix", "cache"),
  );
  const outDir = resolve(
    process.env.COMPAT_OUT ?? join(tmpdir(), "uno-work-compat-matrix", "report"),
  );
  const portBase = Number(process.env.COMPAT_PORT_BASE ?? 13921);
  const wsHoldMs = Number(process.env.COMPAT_WS_HOLD_MS ?? 30_000);
  const skipBuild = process.argv.includes("--no-build");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });

  // An empty value (a workflow input left blank) means "the default list".
  const requested = parseDaemonSpecs(flag("daemons") ?? process.env.COMPAT_DAEMONS ?? "");
  const needsReleases = requested.length === 0 || requested.some((spec) => spec !== CURRENT);
  const sums = needsReleases ? await fetchReleaseSums(baseUrl) : new Map<string, string>();
  const specs =
    requested.length > 0
      ? requested
      : defaultDaemonSpecs({ branchVersion: webVersion, published: sums.keys(), floor });

  const commit = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot })
    .then((result) => result.stdout.trim())
    .catch(() => "unknown");
  log(`fresh web ${webVersion} (${commit}) × daemons: ${specs.join(", ")}`);

  const uiDir = join(repoRoot, "apps/web/dist");
  const currentBin = join(repoRoot, "apps/server/dist/bin.mjs");
  if (!skipBuild || !existsSync(join(uiDir, "index.html"))) {
    log("building the web (once)");
    await run("bun", ["run", "build"], join(repoRoot, "apps/web"), join(outDir, "build.log"));
  }
  // Built even when "current" is not in the list: its routes tell a daemon
  // route from a console route in the static check.
  if (!skipBuild || (specs.includes(CURRENT) && !existsSync(currentBin))) {
    log("building the daemon of this checkout");
    await run("bun", ["run", "build"], join(repoRoot, "apps/server"), join(outDir, "build.log"));
  }

  const rpcMethods = [
    ...(
      WsRpcGroup as unknown as { readonly requests: ReadonlyMap<string, unknown> }
    ).requests.keys(),
  ];
  // Routes the web can call, and which of them even this checkout's daemon
  // does not serve (those belong to the console, not to a computer).
  const webRoutes = apiRoutesOfWebBuild(uiDir);
  const notDaemonRoutes = existsSync(currentBin)
    ? new Set(apiRoutesMissingFromBundle(dirname(currentBin), webRoutes))
    : null;
  const workRoot = mkdtempSync(join(tmpdir(), "uno-work-compat-run-"));
  let browser: Browser | undefined;
  let daemon: RunningDaemon | undefined;
  let proxy: OriginProxy | undefined;
  const stopStand = async () => {
    await proxy?.close().catch(() => undefined);
    proxy = undefined;
    await daemon?.stop().catch(() => undefined);
    daemon = undefined;
  };
  const cleanUp = async () => {
    await stopStand();
    await browser?.close().catch(() => undefined);
    browser = undefined;
    rmSync(workRoot, { recursive: true, force: true });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void cleanUp().finally(() => process.exit(130));
    });
  }

  // Only this run's browser may use the proxy (it holds an owner session).
  const accessToken = randomBytes(24).toString("hex");
  const columns: Array<MatrixColumn> = [];
  try {
    const executablePath = process.env.COMPAT_CHROMIUM;
    browser = await chromium.launch(executablePath ? { executablePath } : {});
    for (const spec of specs) {
      const columnStartedAt = Date.now();
      const name = spec === CURRENT ? "current" : spec;
      const columnDir = join(outDir, name);
      mkdirSync(columnDir, { recursive: true });
      let results: SmokeResults;
      let version = spec === CURRENT ? webVersion : spec;
      try {
        const prepared: PreparedDaemon =
          spec === CURRENT
            ? { spec, binPath: currentBin, bundleDir: dirname(currentBin) }
            : await prepareRelease(spec, sums, { baseUrl, cacheDir, log });
        daemon = await startDaemon({
          daemon: prepared,
          port: portBase,
          workDir: join(workRoot, name),
        });
        version = daemon.descriptor.serverVersion;
        proxy = createOriginProxy({
          uiDir,
          daemonUrl: daemon.url,
          daemonCookie: daemon.cookie,
          uiVersion: webVersion,
          accessToken,
        });
        await assertPortFree(portBase + 1);
        await proxy.listen(portBase + 1);
        const descriptor = daemon.descriptor;
        const httpRoutes =
          notDaemonRoutes === null
            ? null
            : judgeHttpRoutes({
                missing: apiRoutesMissingFromBundle(prepared.bundleDir, webRoutes).filter(
                  (route) => !notDaemonRoutes.has(route),
                ),
                featureRoutes: HTTP_FEATURE_ROUTES,
                daemonSupports: (feature) => daemonSupportsHttpFeature(descriptor, feature),
              });
        log(`${name}: daemon ${version} up, running the smoke`);
        results = await runSmoke({
          browser,
          baseUrl: `http://127.0.0.1:${portBase + 1}`,
          accessToken,
          descriptor: daemon.descriptor,
          webVersion,
          proxyStats: proxy.stats,
          httpRoutes,
          rpcMethodCount: rpcMethods.length,
          rpcMethodsMissing: rpcMethodsMissingFromBundle(prepared.bundleDir, rpcMethods),
          screenshotDir: columnDir,
          wsHoldMs,
        });
        writeJson(join(columnDir, "proxy.json"), proxy.stats);
      } catch (error) {
        results = allFailed(
          `the stand did not come up: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const logFile = daemon?.logFile;
      await stopStand();
      if (logFile && existsSync(logFile)) {
        const text = readFileSync(logFile, "utf8");
        writeFileSync(join(columnDir, "daemon.log"), text.split("\n").slice(-300).join("\n"));
      }
      const failed = CHECKS.filter(({ id }) => results[id].status === "fail").length;
      log(
        `${name}: ${failed === 0 ? "all checks passed" : `${failed} check(s) failed`} in ${Math.round(
          (Date.now() - columnStartedAt) / 1000,
        )} s`,
      );
      columns.push({ name, version, isCurrent: spec === CURRENT, results });
    }
  } finally {
    await cleanUp();
  }

  const report = formatMatrix({
    webVersion,
    commit,
    columns,
    seconds: Math.round((Date.now() - startedAt) / 1000),
  });
  writeJson(join(outDir, "matrix.json"), { webVersion, commit, columns });
  createWriteStream(join(outDir, "matrix.md")).end(`${report}\n`);
  console.log(`\n${report}\n`);
  log(`report: ${outDir}`);
  return columns.some((column) => CHECKS.some(({ id }) => column.results[id].status === "fail"))
    ? 1
    : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(
      `[compat] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exitCode = 2;
  },
);
