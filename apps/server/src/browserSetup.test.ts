import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_SETUP_MIN_FREE_BYTES,
  BROWSER_SETUP_REQUEST_ENV,
  BROWSER_SETUP_STATUS_ENV,
  browserSetupPathsFromEnv,
  isChromiumInstalled,
  makeBrowserSetupController,
  parseInstallerStatus,
  setupMessageForAgent,
  type BrowserSetupController,
} from "./browserSetup.ts";

const controllers: BrowserSetupController[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.stop();
});

function setupDirs() {
  const root = mkdtempSync(join(tmpdir(), "uno-browser-setup-"));
  const paths = {
    requestFile: join(root, "state", "browser-setup", "request"),
    statusFile: join(root, "status", "status.json"),
    browsersDir: join(root, "browsers"),
  };
  mkdirSync(join(root, "status"), { recursive: true });
  return { root, paths };
}

function writeStatus(file: string, status: Record<string, unknown>) {
  writeFileSync(file, JSON.stringify(status));
}

describe("browserSetupPathsFromEnv", () => {
  it("is off unless both paths are set and absolute", () => {
    expect(browserSetupPathsFromEnv({})).toBeNull();
    expect(
      browserSetupPathsFromEnv({
        [BROWSER_SETUP_REQUEST_ENV]: "relative/request",
        [BROWSER_SETUP_STATUS_ENV]: "/s/status.json",
      }),
    ).toBeNull();
    expect(
      browserSetupPathsFromEnv({
        [BROWSER_SETUP_REQUEST_ENV]: "/r/request",
        [BROWSER_SETUP_STATUS_ENV]: "/s/status.json",
        PLAYWRIGHT_BROWSERS_PATH: "/opt/uno-work/browsers",
      }),
    ).toEqual({
      requestFile: "/r/request",
      statusFile: "/s/status.json",
      browsersDir: "/opt/uno-work/browsers",
    });
  });
});

describe("isChromiumInstalled", () => {
  it("waits for playwright's INSTALLATION_COMPLETE marker, not just the binary", () => {
    const { paths } = setupDirs();
    const browserDir = join(paths.browsersDir, "chromium-1200");
    const exe = join(browserDir, "chrome-linux", "chrome");
    expect(isChromiumInstalled(exe, paths.browsersDir)).toBe(false);
    mkdirSync(join(browserDir, "chrome-linux"), { recursive: true });
    writeFileSync(exe, "");
    expect(isChromiumInstalled(exe, paths.browsersDir)).toBe(false);
    writeFileSync(join(browserDir, "INSTALLATION_COMPLETE"), "");
    expect(isChromiumInstalled(exe, paths.browsersDir)).toBe(true);
  });
});

describe("parseInstallerStatus", () => {
  it("accepts the installer's states and rejects junk", () => {
    expect(parseInstallerStatus("nope")).toBeNull();
    expect(parseInstallerStatus(JSON.stringify({ state: "weird" }))).toBeNull();
    expect(
      parseInstallerStatus(
        JSON.stringify({ state: "installing", step: "Downloading the browser", error: null }),
      ),
    ).toMatchObject({ state: "installing", step: "Downloading the browser", error: null });
  });
});

describe("makeBrowserSetupController", () => {
  it("is ready without a request when the browser is installed", async () => {
    const { paths } = setupDirs();
    const controller = makeBrowserSetupController({ paths, isInstalled: async () => true });
    controllers.push(controller);
    const setup = await controller.ensure();
    expect(setup.status).toBe("ready");
    expect(existsSync(paths.requestFile)).toBe(false);
  });

  it("requests the install once and reports progress with the requesting chat", async () => {
    const { paths } = setupDirs();
    const controller = makeBrowserSetupController({
      paths,
      isInstalled: async () => false,
      freeBytes: async () => 10 * 1024 ** 3,
      pollMs: 60_000,
    });
    controllers.push(controller);
    const changes: string[] = [];
    controller.onChange((setup) => changes.push(setup.status));

    const first = await controller.ensure({ context: { threadId: "t1" } });
    expect(first.status).toBe("installing");
    expect(first.context).toEqual({ threadId: "t1" });
    expect(first.secondsLeft).toBeGreaterThan(0);
    expect(existsSync(paths.requestFile)).toBe(true);

    // A second command while it installs does not queue another request.
    const requestBody = readFileSync(paths.requestFile, "utf8");
    const second = await controller.ensure();
    expect(second.status).toBe("installing");
    expect(readFileSync(paths.requestFile, "utf8")).toBe(requestBody);

    // The installer picked it up (removes the request, writes its step).
    const rm = await import("node:fs/promises");
    await rm.rm(paths.requestFile);
    writeStatus(paths.statusFile, {
      state: "installing",
      step: "Downloading the browser",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const progress = await controller.refresh();
    expect(progress.status).toBe("installing");
    expect(progress.step).toBe("Downloading the browser");
    expect(changes).toContain("installing");
  });

  it("becomes ready when the browser appears", async () => {
    const { paths } = setupDirs();
    let installed = false;
    const controller = makeBrowserSetupController({
      paths,
      isInstalled: async () => installed,
      freeBytes: async () => 10 * 1024 ** 3,
      pollMs: 60_000,
    });
    controllers.push(controller);
    await controller.ensure({ context: { threadId: "t1" } });
    installed = true;
    const setup = await controller.refresh();
    expect(setup.status).toBe("ready");
    expect(setup.context).toBeUndefined();
  });

  it("refuses with a clear message when the disk is short", async () => {
    const { paths } = setupDirs();
    const controller = makeBrowserSetupController({
      paths,
      isInstalled: async () => false,
      freeBytes: async () => BROWSER_SETUP_MIN_FREE_BYTES / 4,
    });
    controllers.push(controller);
    const setup = await controller.ensure();
    expect(setup.status).toBe("failed");
    expect(setup.error).toMatch(/Not enough disk space.*0\.5 GB free.*2\.0 GB/);
    expect(existsSync(paths.requestFile)).toBe(false);
    expect(setupMessageForAgent(setup)).toMatch(/could not be set up/);
  });

  it("does not auto-retry a fresh failure, but the retry button does", async () => {
    const { paths } = setupDirs();
    let clock = Date.parse("2026-09-24T12:00:00Z");
    writeStatus(paths.statusFile, {
      state: "failed",
      step: "Downloading the browser",
      error: "Couldn't download the browser.",
      startedAt: new Date(clock - 30_000).toISOString(),
      updatedAt: new Date(clock - 5_000).toISOString(),
    });
    const controller = makeBrowserSetupController({
      paths,
      isInstalled: async () => false,
      freeBytes: async () => 10 * 1024 ** 3,
      now: () => clock,
      pollMs: 60_000,
    });
    controllers.push(controller);

    const agentTry = await controller.ensure();
    expect(agentTry.status).toBe("failed");
    expect(agentTry.error).toBe("Couldn't download the browser.");
    expect(existsSync(paths.requestFile)).toBe(false);

    const button = await controller.ensure({ force: true });
    expect(button.status).toBe("installing");
    expect(existsSync(paths.requestFile)).toBe(true);

    // After the cool-down an agent's command retries on its own too.
    const { rm } = await import("node:fs/promises");
    await rm(paths.requestFile);
    writeStatus(paths.statusFile, {
      state: "failed",
      error: "Couldn't download the browser.",
      updatedAt: new Date(clock).toISOString(),
    });
    clock += 2 * 60_000;
    const later = await controller.ensure();
    expect(later.status).toBe("installing");
  });

  it("reports a request nobody picked up as a failure", async () => {
    const { paths } = setupDirs();
    const clock = Date.now() + 5 * 60_000;
    mkdirSync(join(paths.requestFile, ".."), { recursive: true });
    writeFileSync(paths.requestFile, "x");
    const controller = makeBrowserSetupController({
      paths,
      isInstalled: async () => false,
      now: () => clock,
      pollMs: 60_000,
    });
    controllers.push(controller);
    const setup = await controller.refresh();
    expect(setup.status).toBe("failed");
    expect(setup.error).toMatch(/installer did not start/);
  });

  it("picks up an install that was running before a daemon restart", async () => {
    const { paths } = setupDirs();
    const startedAt = new Date(Date.now() - 30_000).toISOString();
    writeStatus(paths.statusFile, {
      state: "installing",
      step: "Installing system libraries",
      startedAt,
      updatedAt: new Date().toISOString(),
    });
    const controller = makeBrowserSetupController({
      paths,
      isInstalled: async () => false,
      pollMs: 60_000,
    });
    controllers.push(controller);
    const setup = await controller.refresh();
    expect(setup).toMatchObject({
      status: "installing",
      step: "Installing system libraries",
      startedAt,
    });
    expect(setupMessageForAgent(setup)).toMatch(
      /being set up.*Try the same command again in \d+ s/,
    );
  });
});
