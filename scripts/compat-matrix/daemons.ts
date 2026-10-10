/**
 * Daemons for the compatibility matrix: where each version comes from and how
 * one is started, paired with and stopped.
 *
 *   - `current` — `apps/server/dist/bin.mjs` of this checkout;
 *   - `0.0.118` — the public release tarball
 *     `<base>/uno-work-server-0.0.118.tar.gz`, checked against `<base>/SHA256SUMS`
 *     and unpacked the way `deploy/install.sh` does. Its runtime dependencies
 *     are installed with `npm install --omit=dev` once per distinct
 *     dependency set (releases mostly share one) and linked in.
 *
 * Every daemon runs with a clean environment (`HOME`, `PATH`, `LANG`,
 * `TMPDIR` and nothing else) and a throwaway state directory: a daemon
 * started from a shell on a Uno computer would otherwise inherit that
 * computer's box id, agent key and update settings.
 */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const DEFAULT_RELEASE_BASE_URL = "https://console.uno.place/cli/work";
/** The oldest daemon "one window" serves the fresh interface to (WORK_UI_MIN_DAEMON). */
export const DEFAULT_FLOOR_VERSION = "0.0.113";
export const CURRENT = "current";

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Versions with a tarball in a `SHA256SUMS` listing → sha256, `latest` aliases left out. */
export function parseReleaseSums(sums: string): Map<string, string> {
  const releases = new Map<string, string>();
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?uno-work-server-(\d+\.\d+\.\d+)\.tar\.gz$/.exec(
      line.trim(),
    );
    if (match?.[1] && match[2]) releases.set(match[2], match[1]);
  }
  return releases;
}

/**
 * The default column set: this checkout, the two newest public releases that
 * are not newer than it (N-1 and N-2 for a release branch; for a branch whose
 * number is already published, that published build is the nearest older
 * daemon) and the floor.
 */
export function defaultDaemonSpecs(input: {
  readonly branchVersion: string;
  readonly published: Iterable<string>;
  readonly floor: string;
}): Array<string> {
  const older = [...input.published]
    .filter(
      (version) =>
        compareVersions(version, input.branchVersion) <= 0 &&
        compareVersions(version, input.floor) > 0,
    )
    .toSorted((a, b) => compareVersions(b, a))
    .slice(0, 2);
  return [CURRENT, ...older, input.floor];
}

/** `current,0.0.118, 0.0.113` → specs; anything else is a typo worth stopping on. */
export function parseDaemonSpecs(raw: string): Array<string> {
  const specs = raw
    .split(/[\s,]+/)
    .map((spec) => spec.trim().replace(/^v/i, ""))
    .filter((spec) => spec.length > 0);
  for (const spec of specs) {
    if (spec !== CURRENT && !VERSION_PATTERN.test(spec)) {
      throw new Error(`Unknown daemon "${spec}": use "current" or a version like 0.0.118.`);
    }
  }
  return [...new Set(specs)];
}

export interface PreparedDaemon {
  /** `current` or the release version asked for. */
  readonly spec: string;
  readonly binPath: string;
  /** Every `.mjs` of the bundle, for the static RPC check. */
  readonly bundleDir: string;
}

export interface ReleaseSource {
  readonly baseUrl: string;
  readonly cacheDir: string;
  /** Shown while something slow happens. */
  readonly log: (line: string) => void;
}

export async function fetchReleaseSums(baseUrl: string): Promise<Map<string, string>> {
  const response = await fetch(`${baseUrl}/SHA256SUMS`);
  if (!response.ok) throw new Error(`${baseUrl}/SHA256SUMS answered ${response.status}`);
  return parseReleaseSums(await response.text());
}

async function download(url: string, target: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error(`${url} answered ${response.status}`);
  const hash = createHash("sha256");
  const file = createWriteStream(target);
  for await (const chunk of response.body) {
    hash.update(chunk);
    if (!file.write(chunk)) await new Promise<void>((resolve) => file.once("drain", resolve));
  }
  await new Promise<void>((resolve, reject) => {
    file.once("error", reject);
    file.end(() => resolve());
  });
  return hash.digest("hex");
}

function cleanEnv(home: string, tmp: string): Record<string, string> {
  return {
    HOME: home,
    // No provider CLI of the developer's machine: the same daemon behaviour
    // locally and in CI. Node itself and git are all a daemon needs to start.
    PATH: [dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(":"),
    LANG: "C.UTF-8",
    TMPDIR: tmp,
  };
}

/** One `node_modules` per distinct runtime dependency set, shared by the releases that have it. */
async function ensureRuntimeDependencies(
  packageDir: string,
  source: ReleaseSource,
): Promise<string> {
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    readonly dependencies?: Record<string, string>;
    readonly overrides?: Record<string, string>;
  };
  const wanted = JSON.stringify({
    dependencies: manifest.dependencies ?? {},
    overrides: manifest.overrides ?? {},
  });
  const key = createHash("sha256").update(wanted).digest("hex").slice(0, 12);
  const depsDir = join(source.cacheDir, `deps-${key}`);
  const modules = join(depsDir, "node_modules");
  if (existsSync(join(depsDir, ".installed"))) return modules;
  rmSync(depsDir, { recursive: true, force: true });
  mkdirSync(depsDir, { recursive: true });
  writeFileSync(
    join(depsDir, "package.json"),
    `${JSON.stringify({ name: "uno-work-server-deps", private: true, type: "module", ...JSON.parse(wanted) }, null, 2)}\n`,
  );
  source.log(`installing runtime dependencies (${key})`);
  // npm's own cache and config go to a throwaway home, removed right after.
  const home = join(source.cacheDir, "npm-home");
  mkdirSync(home, { recursive: true });
  try {
    await execFileAsync(
      "npm",
      ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
      { cwd: depsDir, env: { ...cleanEnv(home, home), PATH: process.env.PATH ?? "" } },
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  writeFileSync(join(depsDir, ".installed"), `${new Date().toISOString()}\n`);
  return modules;
}

/** Download (once), verify and unpack a release; returns where its `bin.mjs` is. */
export async function prepareRelease(
  version: string,
  sums: ReadonlyMap<string, string>,
  source: ReleaseSource,
): Promise<PreparedDaemon> {
  const packageDir = join(source.cacheDir, version, "package");
  const binPath = join(packageDir, "dist", "bin.mjs");
  if (!existsSync(join(source.cacheDir, version, ".ready"))) {
    const expected = sums.get(version);
    if (!expected) {
      throw new Error(
        `Uno Work ${version} has no tarball in ${source.baseUrl}/SHA256SUMS (published: ${[...sums.keys()].join(", ")}).`,
      );
    }
    const versionDir = join(source.cacheDir, version);
    rmSync(versionDir, { recursive: true, force: true });
    mkdirSync(versionDir, { recursive: true });
    const tarball = join(versionDir, "server.tar.gz");
    source.log(`downloading Uno Work ${version}`);
    const actual = await download(`${source.baseUrl}/uno-work-server-${version}.tar.gz`, tarball);
    if (actual !== expected) {
      throw new Error(`Uno Work ${version}: sha256 ${actual} does not match SHA256SUMS.`);
    }
    await execFileAsync("tar", ["-xzf", tarball, "-C", versionDir]);
    rmSync(tarball);
    if (!existsSync(binPath))
      throw new Error(`Uno Work ${version}: the tarball has no dist/bin.mjs`);
    const modules = await ensureRuntimeDependencies(packageDir, source);
    symlinkSync(modules, join(packageDir, "node_modules"), "dir");
    writeFileSync(join(versionDir, ".ready"), `${new Date().toISOString()}\n`);
  }
  return { spec: version, binPath, bundleDir: dirname(binPath) };
}

/** RPC method names (`tags`) that do not occur anywhere in a daemon bundle. */
export function rpcMethodsMissingFromBundle(
  bundleDir: string,
  tags: ReadonlyArray<string>,
): Array<string> {
  const source = readBundle(bundleDir);
  return tags.filter(
    (tag) =>
      !source.includes(`"${tag}"`) &&
      !source.includes(`'${tag}'`) &&
      !source.includes(`\`${tag}\``),
  );
}

function readBundle(bundleDir: string): string {
  return readdirSync(bundleDir)
    .filter((file) => file.endsWith(".mjs"))
    .map((file) => readFileSync(join(bundleDir, file), "utf8"))
    .join("\n");
}

/** Every `/api/…` path written out in the built web (`dist/assets/*.js`). */
export function apiRoutesOfWebBuild(webDistDir: string): Array<string> {
  const assets = join(webDistDir, "assets");
  const routes = new Set<string>();
  for (const file of readdirSync(assets)) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(join(assets, file), "utf8");
    for (const match of source.matchAll(/["'`](\/api\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*)/g)) {
      if (match[1]) routes.add(match[1]);
    }
  }
  return [...routes].toSorted();
}

/** Of `routes`, those that do not occur anywhere in a daemon bundle. */
export function apiRoutesMissingFromBundle(
  bundleDir: string,
  routes: ReadonlyArray<string>,
): Array<string> {
  const source = readBundle(bundleDir);
  return routes.filter((route) => !source.includes(route));
}

/** What the daemon says about itself at `/.well-known/t3/environment`. */
export interface DaemonDescriptor {
  readonly serverVersion: string;
  readonly label: string;
  readonly environmentId: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
}

export interface RunningDaemon {
  readonly url: string;
  readonly descriptor: DaemonDescriptor;
  /** The owner session the proxy holds for the browser (`name=value; …`). */
  readonly cookie: string;
  readonly logFile: string;
  readonly stop: () => Promise<void>;
}

/** Fails when something already listens there: the smoke must talk to the daemon it started. */
export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(new Error(`port ${port} on 127.0.0.1 is taken (set COMPAT_PORT_BASE)`)),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}

async function waitForHealth(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the daemon exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the daemon did not answer /api/health in ${Math.round(timeoutMs / 1000)} s`);
}

function stopProcessGroup(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.pid === undefined) {
      resolve();
      return;
    }
    const pid = child.pid;
    const signal = (name: NodeJS.Signals) => {
      try {
        // Negative pid: the daemon and whatever it started (provider processes).
        process.kill(-pid, name);
      } catch {
        // already gone
      }
    };
    const force = setTimeout(() => signal("SIGKILL"), 8_000);
    child.once("exit", () => {
      clearTimeout(force);
      // Children that outlived the daemon's own shutdown.
      signal("SIGKILL");
      resolve();
    });
    signal("SIGTERM");
  });
}

/**
 * Start a daemon on loopback and pair with it the way the console's proxy
 * does: a one-time owner token from the daemon's CLI, exchanged at
 * `POST /api/auth/bootstrap` for the session cookie.
 */
export async function startDaemon(input: {
  readonly daemon: PreparedDaemon;
  readonly port: number;
  /** Throwaway directory for this daemon: home, state, workspace, tmp, log. */
  readonly workDir: string;
}): Promise<RunningDaemon> {
  for (const port of [input.port, input.port + 2]) await assertPortFree(port);
  const home = join(input.workDir, "home");
  const state = join(input.workDir, "state");
  const workspace = join(input.workDir, "workspace");
  const tmp = join(input.workDir, "tmp");
  for (const dir of [home, state, workspace, tmp]) mkdirSync(dir, { recursive: true });
  const env = {
    ...cleanEnv(home, tmp),
    T3CODE_STARTUP_PAIRING_OUTPUT: "0",
    // The App SDK's local API has a fixed default port (3779): on a Uno
    // computer the real daemon holds it. Keep the stand inside its own range.
    UNO_WORK_APP_API_PORT: String(input.port + 2),
  };
  const logFile = join(input.workDir, "daemon.log");
  const log = createWriteStream(logFile);
  const child = spawn(
    process.execPath,
    [
      input.daemon.binPath,
      "serve",
      "--mode",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(input.port),
      "--base-dir",
      state,
      workspace,
    ],
    { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const url = `http://127.0.0.1:${input.port}`;
  const stop = () => stopProcessGroup(child);
  try {
    await waitForHealth(url, child, 60_000);
    const descriptor = (await (
      await fetch(`${url}/.well-known/t3/environment`)
    ).json()) as DaemonDescriptor;
    if (input.daemon.spec !== CURRENT && descriptor.serverVersion !== input.daemon.spec) {
      throw new Error(
        `asked for Uno Work ${input.daemon.spec}, the daemon says ${descriptor.serverVersion}`,
      );
    }
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        input.daemon.binPath,
        "auth",
        "pairing",
        "create",
        "--base-dir",
        state,
        "--ttl",
        "5m",
        "--role",
        "owner",
        "--label",
        "proxy",
        "--json",
      ],
      { cwd: workspace, env },
    );
    const pairing = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1)) as {
      readonly credential?: string;
    };
    if (!pairing.credential) throw new Error("the daemon gave no pairing credential");
    const bootstrap = await fetch(`${url}/api/auth/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ credential: pairing.credential }),
    });
    const cookie = bootstrap.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0] ?? "")
      .filter((value) => value.length > 0)
      .join("; ");
    if (!bootstrap.ok || cookie.length === 0) {
      throw new Error(`pairing: /api/auth/bootstrap answered ${bootstrap.status} with no session`);
    }
    return { url, descriptor, cookie, logFile, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A report file, written whole (a reader never sees half of it). */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const next = `${file}.next`;
  writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(next, file);
}
