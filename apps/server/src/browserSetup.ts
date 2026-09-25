import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { BrowserBridgeRequestContext, BrowserLiveSetup } from "@t3tools/contracts";

/**
 * Браузер машины ставится при первом использовании, а не в образ Work: образ
 * вырос бы на ~1,1 ГБ (Chromium + системные либы) на каждой машине, а браузер
 * нужен не всем.
 *
 * Ставит root: демон работает без привилегий (NoNewPrivileges, sudo нет), поэтому
 * он только кладёт файл-запрос. install.sh заводит `uno-work-browser-setup.path`:
 * systemd видит файл и запускает root-oneshot `uno-work-browser-setup` — тот
 * ставит Xvfb + Chromium тем же способом, что раньше install.sh, и пишет
 * прогресс в status.json (каталог root, демон только читает). Установка идёт
 * отдельным юнитом — переживает рестарт демона; повторный запрос на уже
 * поставленном браузере завершается за секунду.
 *
 * Пути приходят из drop-in `uno-work.service.d/browser.conf`. Нет переменных —
 * машина не умеет ставить браузер сама (десктоп, dev): считаем его готовым и
 * ведём себя как раньше (ошибка запуска скажет, чего не хватает).
 */

export const BROWSER_SETUP_REQUEST_ENV = "UNO_WORK_BROWSER_SETUP_REQUEST";
export const BROWSER_SETUP_STATUS_ENV = "UNO_WORK_BROWSER_SETUP_STATUS";

/** Столько свободного места нужно под Chromium, либы и распаковку. */
export const BROWSER_SETUP_MIN_FREE_BYTES = 2 * 1024 ** 3;
/** Типичная установка на 1 vCPU: замер 24.09 на свежей машине из golden 169 — 31 с (+запас на сеть). */
export const BROWSER_SETUP_TYPICAL_SECONDS = 45;
/** Дольше установщик не живёт (TimeoutStartSec юнита — 20 мин). */
const STALE_INSTALL_MS = 25 * 60_000;
/** Запрос лежит, а установщик так и не начал — .path-юнит не работает. */
const REQUEST_NOT_PICKED_MS = 2 * 60_000;
/** После неудачи агент не перезапускает установку чаще, чем раз в столько. */
const AUTO_RETRY_COOLDOWN_MS = 60_000;
const POLL_MS = 2_000;

export interface BrowserSetupPaths {
  /** Файл-запрос (каталог принадлежит демону); его смотрит .path-юнит. */
  readonly requestFile: string;
  /** Прогресс установщика (пишет root). */
  readonly statusFile: string;
  /** Где лежат браузеры playwright (PLAYWRIGHT_BROWSERS_PATH); для проверки места. */
  readonly browsersDir: string | null;
}

export function browserSetupPathsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BrowserSetupPaths | null {
  const requestFile = env[BROWSER_SETUP_REQUEST_ENV]?.trim();
  const statusFile = env[BROWSER_SETUP_STATUS_ENV]?.trim();
  if (!requestFile || !statusFile || !isAbsolute(requestFile) || !isAbsolute(statusFile)) {
    return null;
  }
  const browsersDir = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  return {
    requestFile,
    statusFile,
    browsersDir: browsersDir && isAbsolute(browsersDir) ? browsersDir : null,
  };
}

/**
 * Chromium поставлен целиком: бинарь есть и playwright дописал маркер
 * INSTALLATION_COMPLETE в каталог браузера (бинарь появляется раньше, ещё во
 * время распаковки).
 */
export function isChromiumInstalled(executablePath: string, browsersDir: string | null): boolean {
  if (!executablePath || !existsSync(executablePath)) return false;
  if (!browsersDir) return true;
  const inside = relative(browsersDir, executablePath);
  if (inside.startsWith("..") || isAbsolute(inside)) return true;
  const browserDir = inside.split(sep)[0];
  return browserDir ? existsSync(join(browsersDir, browserDir, "INSTALLATION_COMPLETE")) : true;
}

/** Что пишет установщик (deploy/install.sh → uno-work-browser-setup). */
interface InstallerStatus {
  readonly state: "installing" | "ready" | "failed";
  readonly step: string | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
}

function statusText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

export function parseInstallerStatus(body: string): InstallerStatus | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const state = parsed.state;
    if (state !== "installing" && state !== "ready" && state !== "failed") return null;
    return {
      state,
      step: statusText(parsed.step),
      error: statusText(parsed.error),
      startedAt: statusText(parsed.startedAt),
      updatedAt: statusText(parsed.updatedAt),
    };
  } catch {
    return null;
  }
}

function failedSetup(error: string): BrowserLiveSetup {
  return { status: "failed", step: null, startedAt: null, secondsLeft: null, error };
}

export const READY_SETUP: BrowserLiveSetup = {
  status: "ready",
  step: null,
  startedAt: null,
  secondsLeft: null,
  error: null,
};

export function secondsLeft(startedAt: string | null, now: number): number {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsed = Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : 0;
  return Math.max(10, Math.round(BROWSER_SETUP_TYPICAL_SECONDS - elapsed));
}

function formatGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}

export function notEnoughDiskMessage(freeBytes: number): string {
  return (
    `Not enough disk space to set up the browser: ${formatGb(freeBytes)} GB free, ` +
    `it needs ${formatGb(BROWSER_SETUP_MIN_FREE_BYTES)} GB. Free up space on this computer ` +
    "or give it a bigger disk, then try again."
  );
}

/**
 * Ответ агенту, пока браузер не готов. Агент не должен висеть: говорим, когда
 * повторить, и что делать при неудаче.
 */
export function setupMessageForAgent(setup: BrowserLiveSetup): string {
  switch (setup.status) {
    case "installing":
    case "missing": {
      const wait = setup.secondsLeft ?? BROWSER_SETUP_TYPICAL_SECONDS;
      return (
        "This computer's browser is being set up (first use, takes about a minute" +
        `${setup.step ? `; now: ${setup.step}` : ""}). Try the same command again in ${wait} s. ` +
        "Meanwhile continue with other work; do not retry in a tight loop."
      );
    }
    case "failed":
      return (
        `This computer's browser could not be set up: ${setup.error ?? "unknown error"} ` +
        "Tell the person in chat; they can press Try again in the browser panel. " +
        "Setup is retried automatically on your next browser command after a minute."
      );
    case "ready":
      return "";
  }
}

export interface BrowserSetupDeps {
  readonly paths: BrowserSetupPaths;
  /** Chromium поставлен целиком (см. isChromiumInstalled). */
  readonly isInstalled: () => Promise<boolean>;
  readonly freeBytes?: (path: string) => Promise<number | null>;
  readonly now?: () => number;
  readonly pollMs?: number;
}

export interface BrowserSetupController {
  readonly current: () => BrowserLiveSetup;
  /** Перечитать диск и статус установщика. */
  readonly refresh: () => Promise<BrowserLiveSetup>;
  /**
   * Готов ли браузер; если нет — запустить установку (один раз: идущую не
   * дублирует). `force` — ретрай по кнопке, без паузы после неудачи.
   */
  readonly ensure: (options?: {
    readonly force?: boolean;
    readonly context?: BrowserBridgeRequestContext | undefined;
  }) => Promise<BrowserLiveSetup>;
  readonly onChange: (listener: (setup: BrowserLiveSetup) => void) => () => void;
  readonly stop: () => void;
}

async function defaultFreeBytes(path: string): Promise<number | null> {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** Ближайший существующий предок: каталога браузеров до установки может не быть. */
function existingAncestor(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function makeBrowserSetupController(deps: BrowserSetupDeps): BrowserSetupController {
  const now = deps.now ?? Date.now;
  const freeBytes = deps.freeBytes ?? defaultFreeBytes;
  const pollMs = deps.pollMs ?? POLL_MS;
  const listeners = new Set<(setup: BrowserLiveSetup) => void>();
  let state: BrowserLiveSetup = {
    status: "missing",
    step: null,
    startedAt: null,
    secondsLeft: null,
    error: null,
  };
  let context: BrowserBridgeRequestContext | undefined;
  /** Своя ошибка демона (мало места) — установщик её не видел. */
  let localFailure: { error: string; at: number } | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const withContext = (setup: BrowserLiveSetup): BrowserLiveSetup =>
    context && setup.status !== "ready" ? { ...setup, context } : setup;

  const publish = (next: BrowserLiveSetup) => {
    const withCtx = withContext(next);
    const changed = JSON.stringify(withCtx) !== JSON.stringify(state);
    state = withCtx;
    if (state.status === "installing") startPolling();
    else stopPolling();
    if (changed) for (const listener of listeners) listener(state);
    return state;
  };

  const startPolling = () => {
    if (timer || stopped) return;
    timer = setInterval(() => {
      void refresh();
    }, pollMs);
    timer.unref?.();
  };
  const stopPolling = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };

  const readInstaller = async (): Promise<InstallerStatus | null> => {
    try {
      return parseInstallerStatus(await readFile(deps.paths.statusFile, "utf8"));
    } catch {
      return null;
    }
  };

  const requestTime = async (): Promise<number | null> => {
    try {
      return (await stat(deps.paths.requestFile)).mtimeMs;
    } catch {
      return null;
    }
  };

  const compute = async (): Promise<BrowserLiveSetup> => {
    if (await deps.isInstalled().catch(() => false)) {
      localFailure = null;
      return READY_SETUP;
    }
    const at = now();
    const installer = await readInstaller();
    const requestedAt = await requestTime();
    const installerAt = installer?.updatedAt ? Date.parse(installer.updatedAt) : Number.NaN;
    const installing = (startedAt: string | null, step: string | null): BrowserLiveSetup => ({
      status: "installing",
      step: step ?? "Getting ready",
      startedAt,
      secondsLeft: secondsLeft(startedAt, at),
      error: null,
    });

    // Запрос новее последней записи установщика: он ещё не взялся за него.
    if (requestedAt !== null && !(installerAt >= requestedAt)) {
      if (at - requestedAt > REQUEST_NOT_PICKED_MS) {
        return failedSetup(
          "The browser installer did not start. Update Uno Work on this computer and try again.",
        );
      }
      return installing(new Date(requestedAt).toISOString(), "Waiting for the installer");
    }
    if (installer?.state === "installing") {
      const started = installer.startedAt ? Date.parse(installer.startedAt) : Number.NaN;
      if (Number.isFinite(started) && at - started > STALE_INSTALL_MS) {
        return failedSetup("Browser setup stopped responding.");
      }
      return installing(installer.startedAt, installer.step);
    }
    if (installer?.state === "failed") {
      return failedSetup(installer.error ?? "Browser setup failed.");
    }
    if (localFailure) return failedSetup(localFailure.error);
    // "ready" у установщика, а браузера нет — Uno Work обновился на новый
    // Chromium: ставим заново.
    return { status: "missing", step: null, startedAt: null, secondsLeft: null, error: null };
  };

  let refreshing: Promise<BrowserLiveSetup> | null = null;
  const refresh = (): Promise<BrowserLiveSetup> => {
    if (!refreshing) {
      refreshing = compute()
        .then(publish)
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  };

  const failedAt = async (): Promise<number | null> => {
    if (localFailure) return localFailure.at;
    const installer = await readInstaller();
    const updated = installer?.updatedAt ? Date.parse(installer.updatedAt) : Number.NaN;
    return Number.isFinite(updated) ? updated : null;
  };

  let starting: Promise<BrowserLiveSetup> | null = null;
  const ensure: BrowserSetupController["ensure"] = async (options = {}) => {
    if (starting) return starting;
    starting = (async () => {
      const current = await refresh();
      if (current.status === "ready" || current.status === "installing") return current;
      if (current.status === "failed" && !options.force) {
        const at = await failedAt();
        if (at !== null && now() - at < AUTO_RETRY_COOLDOWN_MS) return current;
      }
      if (options.context) context = options.context;
      const probe = existingAncestor(deps.paths.browsersDir ?? dirname(deps.paths.statusFile));
      const free = await freeBytes(probe);
      if (free !== null && free < BROWSER_SETUP_MIN_FREE_BYTES) {
        localFailure = { error: notEnoughDiskMessage(free), at: now() };
        return publish(failedSetup(localFailure.error));
      }
      localFailure = null;
      const requestedAt = new Date(now()).toISOString();
      await mkdir(dirname(deps.paths.requestFile), { recursive: true });
      const temp = `${deps.paths.requestFile}.tmp`;
      await writeFile(temp, `${requestedAt}\n`);
      await rename(temp, deps.paths.requestFile);
      return publish({
        status: "installing",
        step: "Waiting for the installer",
        startedAt: requestedAt,
        secondsLeft: BROWSER_SETUP_TYPICAL_SECONDS,
        error: null,
      });
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  return {
    current: () => state,
    refresh,
    ensure,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop: () => {
      stopped = true;
      stopPolling();
      listeners.clear();
    },
  };
}
