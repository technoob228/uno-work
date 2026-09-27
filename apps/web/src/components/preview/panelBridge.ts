/**
 * Мост «панель плагина ↔ приложение» (MessagePort).
 *
 * Панель — статический HTML в sandbox-iframe без `allow-same-origin`, т.е. на
 * opaque origin. У неё нет ни DOM приложения, ни его кук, ни сессии.
 *
 * Канал (см. `attachPanelPortHost`): на ПЕРВЫЙ `load` iframe хост создаёт
 * `MessageChannel` и отдаёт панели `port2` одним сообщением
 *
 *   iframe.contentWindow.postMessage({ type: "uno-panel-init" }, "*", [port2])
 *
 * `targetOrigin "*"` — вынужденно (у opaque origin адреса нет), но в этом
 * сообщении нет данных, только порт. Дальше всё общение — ТОЛЬКО через порт:
 *
 *   port.postMessage({ __unoPanel: 1, id, method, params })
 *   → ответ { __unoPanel: 1, id, result } либо { __unoPanel: 1, id, error }
 *
 * Правила безопасности (граница доверия — манифест, панель прав не расширяет):
 * - `message` на window хост не слушает вообще: порт получил только документ,
 *   загруженный по подписанной ссылке, и подделать отправителя нельзя;
 * - если фрейм навигировал (второй и последующие `load`), порт закрывается и
 *   новый НЕ выдаётся: чужой документ в том же iframe моста не получит;
 * - словарь методов фиксированный, неизвестный метод → `error`;
 * - rate limit (по умолчанию 10 вызовов в секунду на вкладку) — панель не
 *   должна иметь возможности завалить приложение или оркестрацию;
 * - события наружу отдаются только по явной подписке (`subscribe`) и только по
 *   проекту вкладки — фильтрует хост.
 */
import { hookMatches } from "@t3tools/shared/pluginPatterns";

import type { ShellEventNotice } from "../../environments/runtime/shellEventBus";

/** Тип единственного window-сообщения хоста: передача порта панели. */
export const PANEL_INIT_MESSAGE_TYPE = "uno-panel-init";

/** Маркер протокола: он же отличает наши сообщения от чужих postMessage. */
export const PANEL_BRIDGE_MARKER = "__unoPanel";
export const PANEL_BRIDGE_VERSION = 1;
export const DEFAULT_PANEL_BRIDGE_RATE_LIMIT = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
/** Больше одного паттерна панели ни к чему; защита от накопления мусора. */
const MAX_SUBSCRIPTIONS = 16;

export interface PanelBridgeRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export type PanelBridgeResponse =
  | { readonly __unoPanel: 1; readonly id: string | number; readonly result: unknown }
  | { readonly __unoPanel: 1; readonly id: string | number; readonly error: string };

export interface PanelBridgeEventMessage {
  readonly __unoPanel: 1;
  readonly event: PanelBridgeEvent;
}

/** Событие оркестрации в терминах панели: плоский тип + минимум полезных полей. */
export interface PanelBridgeEvent {
  readonly type: string;
  readonly projectId: string;
  readonly payload: Record<string, unknown>;
}

/**
 * Методы v1. Реализацию даёт хост (вкладка знает свой проект и окружение).
 * Возвращаемое значение уходит в `result`; брошенная ошибка — в `error`.
 */
export interface PanelBridgeMethods {
  readonly openFile: (params: { readonly path: string }) => void | Promise<void>;
  readonly openUrl: (params: { readonly url: string }) => void | Promise<void>;
  readonly sendToThread: (params: {
    readonly text: string;
    readonly threadTag?: string;
  }) => unknown | Promise<unknown>;
}

export const PANEL_BRIDGE_METHODS = ["openFile", "openUrl", "sendToThread", "subscribe"] as const;
export type PanelBridgeMethodName = (typeof PANEL_BRIDGE_METHODS)[number];

export interface PanelBridgeOptions {
  readonly methods: PanelBridgeMethods;
  /** Куда отправлять ответы и события (порт из `attachPanelPortHost`). */
  readonly post: (message: PanelBridgeResponse | PanelBridgeEventMessage) => void;
  readonly maxCallsPerSecond?: number;
  readonly now?: () => number;
}

export interface PanelBridge {
  /** Обработать сообщение от панели — только то, что пришло в её порт. */
  readonly handleMessage: (data: unknown) => void;
  /** Прокинуть событие оркестрации в панель, если оно подходит под подписки. */
  readonly emitEvent: (event: PanelBridgeEvent) => void;
  /** Текущие паттерны подписки — для тестов и отладки. */
  readonly subscriptions: () => ReadonlyArray<string>;
}

/** Разбирает входящее сообщение; `null` — это не наш протокол. */
export function parsePanelRequest(data: unknown): PanelBridgeRequest | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record[PANEL_BRIDGE_MARKER] !== PANEL_BRIDGE_VERSION) return null;
  const id = record.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const method = record.method;
  if (typeof method !== "string") return null;
  return { id, method, params: record.params };
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : "Panel bridge call failed";
}

function requireString(params: unknown, key: string): string {
  const value =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`"${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(params: unknown, key: string): string | undefined {
  const value =
    typeof params === "object" && params !== null
      ? (params as Record<string, unknown>)[key]
      : undefined;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`"${key}" must be a string`);
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Событие shell-потока → событие панели.
 *
 * Отклонение от ТЗ, продиктованное кодом: у клиента нет сырого потока
 * доменных событий с `type` — по WS приезжает проекция (`subscribeShell`) с
 * `kind`: `thread-upserted` / `thread-removed` / `project-upserted` /
 * `project-removed`. Поэтому словарь панели — точечный перевод этих четырёх
 * видов в точечную нотацию (`thread.upserted` и т.д.), совместимую с
 * `hookMatches`: `"thread.*"` и `"*"` работают как в хуках манифеста.
 *
 * `null` — событие, у которого нет проекта (удалённый тред, которого мы уже
 * не знаем): отдать его «только по проекту вкладки» невозможно.
 */
export function shellEventToPanelEvent(notice: ShellEventNotice): PanelBridgeEvent | null {
  const event = notice.event;
  switch (event.kind) {
    case "project-upserted":
      return {
        type: "project.upserted",
        projectId: event.project.id,
        payload: {
          projectId: event.project.id,
          title: event.project.title,
          workspaceRoot: event.project.workspaceRoot,
          updatedAt: event.project.updatedAt,
        },
      };
    case "project-removed":
      return {
        type: "project.removed",
        projectId: event.projectId,
        payload: { projectId: event.projectId },
      };
    case "thread-upserted":
      return {
        type: "thread.upserted",
        projectId: event.thread.projectId,
        payload: {
          threadId: event.thread.id,
          projectId: event.thread.projectId,
          title: event.thread.title,
          runtimeMode: event.thread.runtimeMode,
          archived: event.thread.archivedAt !== null,
          turnState: event.thread.latestTurn?.state ?? null,
          hasPendingApprovals: event.thread.hasPendingApprovals,
          updatedAt: event.thread.updatedAt,
        },
      };
    case "thread-removed":
      return notice.removedThreadProjectId === null
        ? null
        : {
            type: "thread.removed",
            projectId: notice.removedThreadProjectId,
            payload: { threadId: event.threadId },
          };
  }
}

export function createPanelBridge(options: PanelBridgeOptions): PanelBridge {
  const now = options.now ?? (() => Date.now());
  const maxCallsPerSecond = options.maxCallsPerSecond ?? DEFAULT_PANEL_BRIDGE_RATE_LIMIT;
  const recentCalls: number[] = [];
  const patterns: string[] = [];

  const allowCall = (): boolean => {
    const timestamp = now();
    while (recentCalls.length > 0 && timestamp - recentCalls[0]! >= RATE_LIMIT_WINDOW_MS) {
      recentCalls.shift();
    }
    if (recentCalls.length >= maxCallsPerSecond) return false;
    recentCalls.push(timestamp);
    return true;
  };

  const respond = (id: string | number, result: unknown) => {
    options.post({ __unoPanel: PANEL_BRIDGE_VERSION, id, result });
  };

  const respondError = (id: string | number, message: string) => {
    options.post({ __unoPanel: PANEL_BRIDGE_VERSION, id, error: message });
  };

  const invoke = async (request: PanelBridgeRequest): Promise<unknown> => {
    switch (request.method) {
      case "openFile":
        await options.methods.openFile({ path: requireString(request.params, "path") });
        return { ok: true };
      case "openUrl":
        await options.methods.openUrl({ url: requireString(request.params, "url") });
        return { ok: true };
      case "sendToThread": {
        const threadTag = optionalString(request.params, "threadTag");
        return await options.methods.sendToThread({
          text: requireString(request.params, "text"),
          ...(threadTag !== undefined ? { threadTag } : {}),
        });
      }
      case "subscribe": {
        const pattern = requireString(request.params, "pattern");
        if (!patterns.includes(pattern)) {
          if (patterns.length >= MAX_SUBSCRIPTIONS) {
            throw new Error(`too many subscriptions (max ${MAX_SUBSCRIPTIONS})`);
          }
          patterns.push(pattern);
        }
        return { subscribed: pattern };
      }
      default:
        throw new Error(`unknown method "${request.method}"`);
    }
  };

  return {
    handleMessage: (data) => {
      const request = parsePanelRequest(data);
      if (request === null) return;
      if (!allowCall()) {
        respondError(request.id, `rate limit exceeded (${maxCallsPerSecond} calls/sec)`);
        return;
      }
      void invoke(request).then(
        (result) => respond(request.id, result),
        (cause: unknown) => respondError(request.id, errorMessage(cause)),
      );
    },
    emitEvent: (event) => {
      if (patterns.length === 0) return;
      if (!patterns.some((pattern) => hookMatches(pattern, event.type))) return;
      options.post({ __unoPanel: PANEL_BRIDGE_VERSION, event });
    },
    subscriptions: () => [...patterns],
  };
}

/** Минимум iframe, который нужен хосту порта (в тестах — заглушка). */
export interface PanelPortFrame {
  addEventListener(type: "load", listener: () => void): void;
  removeEventListener(type: "load", listener: () => void): void;
  readonly contentWindow: {
    postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
  } | null;
}

export interface PanelPortHost {
  /** Отправить панели сообщение; до выдачи порта и после отзыва — no-op. */
  readonly post: (message: unknown) => void;
  /** Снять слушатель и закрыть порт (размонтирование вкладки). */
  readonly dispose: () => void;
}

/**
 * Выдаёт документу панели MessagePort на первый `load` iframe и дальше
 * слушает только его. Любой следующий `load` значит, что во фрейме уже другой
 * документ (панель перешла по ссылке или перезагрузилась): порт закрывается,
 * новый не выдаётся — вкладку надо открыть заново (новая подписанная ссылка).
 */
export function attachPanelPortHost(options: {
  readonly frame: PanelPortFrame;
  readonly onMessage: (data: unknown) => void;
  readonly createChannel?: () => MessageChannel;
}): PanelPortHost {
  const createChannel = options.createChannel ?? (() => new MessageChannel());
  let port: MessagePort | null = null;
  let granted = false;
  let disposed = false;

  const onPortMessage = (event: MessageEvent) => {
    options.onMessage(event.data);
  };

  const closePort = () => {
    if (port === null) return;
    port.removeEventListener("message", onPortMessage);
    port.close();
    port = null;
  };

  const onLoad = () => {
    if (disposed) return;
    if (granted) {
      closePort();
      return;
    }
    const target = options.frame.contentWindow;
    if (target === null) return;
    granted = true;
    const channel = createChannel();
    port = channel.port1;
    port.addEventListener("message", onPortMessage);
    port.start();
    target.postMessage({ type: PANEL_INIT_MESSAGE_TYPE }, "*", [channel.port2]);
  };

  options.frame.addEventListener("load", onLoad);
  return {
    post: (message) => {
      port?.postMessage(message);
    },
    dispose: () => {
      disposed = true;
      options.frame.removeEventListener("load", onLoad);
      closePort();
    },
  };
}
