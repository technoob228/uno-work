/**
 * Кастомный AI-интерфейс (фаза C ТЗ `.plans/20-plugin-panels-custom-ai-ui.md`):
 * вкладка панели плагина, у которой в манифесте объявлен `panel.chat`,
 * показывает split — сам плагин в sandbox-iframe плюс хост-чат рядом.
 *
 * Тред резолвится серверным RPC `plugins.resolvePanelThread` — ТОЙ ЖЕ картой
 * `pluginId + threadTag → threadId`, что и `plugins.sendToThread`. Один тред на
 * панель: нажатие кнопки внутри плагина и реплика в чате попадают в одну
 * переписку. Карта живёт в памяти демона, поэтому после его рестарта панель
 * заводит новый тред — принятое поведение (фаза B).
 *
 * Отклонение от буквы ТЗ: split вертикальный (панель сверху, чат снизу), а не
 * «слева/справа» — правая панель приложения по умолчанию узкая (~24rem), и
 * горизонтальное деление там нечитаемо. В фокус-режиме пропорция та же.
 */
import type {
  EnvironmentId,
  PluginPanelChatVisibility,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { cn } from "../../lib/utils";
import { EmbeddedThreadChat } from "../chat/EmbeddedThreadChat";
import type { EmbeddedChatVisibility } from "../chat/embeddedChatVisibility";

export interface PluginPanelDescriptor {
  readonly id: string;
  readonly title: string;
  readonly chat?: { readonly threadTag: string; readonly visibility: PluginPanelChatVisibility };
}

/**
 * Живой список панельных плагинов. Раньше меню «+» читало его разово по клику —
 * плагин, созданный агентом в этот момент, в меню не появлялся до следующего
 * открытия. Подписка одна на панель и разделяется всеми потребителями.
 */
export function usePluginPanels(): ReadonlyArray<PluginPanelDescriptor> {
  const [panels, setPanels] = useState<ReadonlyArray<PluginPanelDescriptor>>([]);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = getPrimaryEnvironmentConnection().client.server.subscribePlugins((snapshot) => {
        if (cancelled) return;
        setPanels(
          snapshot.plugins.flatMap((plugin) =>
            plugin.valid && plugin.enabled && plugin.panel
              ? [
                  {
                    id: plugin.id,
                    title: plugin.panel.title,
                    ...(plugin.panel.chat ? { chat: plugin.panel.chat } : {}),
                  },
                ]
              : [],
          ),
        );
      });
    } catch {
      // Демон недоступен — панелей просто нет.
    }
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return panels;
}

const SPLIT_STORAGE_KEY = "plugin_panel_chat_split";
const DEFAULT_PANEL_FRACTION = 0.6;
const MIN_PANEL_FRACTION = 0.2;
const MAX_PANEL_FRACTION = 0.85;

export function readStoredPanelFraction(): number {
  if (typeof window === "undefined") return DEFAULT_PANEL_FRACTION;
  const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
  const parsed = raw === null ? Number.NaN : Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_PANEL_FRACTION;
  return clampPanelFraction(parsed);
}

export function clampPanelFraction(value: number): number {
  return Math.min(MAX_PANEL_FRACTION, Math.max(MIN_PANEL_FRACTION, value));
}

/**
 * Split «панель + чат». Панель (iframe) передаётся элементом и НИКОГДА не
 * меняет позицию в дереве — иначе React пересоздал бы iframe и перезагрузил
 * документ плагина вместе с его состоянием.
 */
export function PluginPanelSplit({
  panel,
  chat,
}: {
  panel: React.ReactNode;
  chat: React.ReactNode | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [fraction, setFraction] = useState(readStoredPanelFraction);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      if (rect.height <= 0) return;
      setFraction(clampPanelFraction((event.clientY - rect.top) / rect.height));
    },
    [dragging],
  );

  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      setDragging(false);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
      window.localStorage.setItem(SPLIT_STORAGE_KEY, String(fraction));
    },
    [dragging, fraction],
  );

  return (
    <div ref={containerRef} className="flex h-full w-full min-h-0 flex-col">
      <div
        className="min-h-0 w-full"
        style={chat === null ? { flex: "1 1 auto" } : { flex: `0 0 ${fraction * 100}%` }}
      >
        {panel}
      </div>
      {chat === null ? null : (
        <>
          <div
            role="separator"
            aria-orientation="horizontal"
            aria-label="Изменить размер чата панели"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={cn(
              "h-1.5 w-full shrink-0 cursor-row-resize border-y border-border bg-border/40 hover:bg-accent",
              dragging && "bg-accent",
            )}
          />
          <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
            {chat}
          </div>
        </>
      )}
    </div>
  );
}

type ChatThreadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly threadId: ThreadId }
  | { readonly status: "error"; readonly message: string };

/**
 * Чат панели: резолвит тред через тот же серверный mapping, что sendToThread,
 * и отдаёт его в хост-чат. Панели работают только с проектами основного
 * окружения (URL панели относительный — её раздаёт демон primary-окружения),
 * поэтому для чужого окружения честно отказываем.
 */
export function PluginPanelChat({
  pluginId,
  threadTag,
  visibility,
  projectId,
  environmentId,
  primaryEnvironmentId,
}: {
  pluginId: string;
  threadTag: string;
  visibility: PluginPanelChatVisibility;
  projectId: ProjectId | null;
  environmentId: EnvironmentId | null;
  primaryEnvironmentId: EnvironmentId | null;
}) {
  const [state, setState] = useState<ChatThreadState>({ status: "idle" });
  const foreignEnvironment =
    environmentId !== null &&
    primaryEnvironmentId !== null &&
    environmentId !== primaryEnvironmentId;

  useEffect(() => {
    if (projectId === null || foreignEnvironment) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void getPrimaryEnvironmentConnection()
      .client.server.resolvePluginPanelThread({ pluginId, projectId, threadTag })
      .then((result) => {
        if (cancelled) return;
        setState({ status: "ready", threadId: result.threadId });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [foreignEnvironment, pluginId, projectId, threadTag]);

  if (foreignEnvironment) {
    return <PanelChatNotice text="Панель работает только с проектами основного окружения" />;
  }
  if (projectId === null) {
    return <PanelChatNotice text="Откройте тред проекта — чат панели живёт в его проекте" />;
  }
  if (state.status === "error") {
    return <PanelChatNotice text={state.message} />;
  }
  if (state.status !== "ready" || primaryEnvironmentId === null) {
    return (
      <PanelChatNotice
        icon={<Loader2Icon className="size-3.5 animate-spin" />}
        text="Готовим тред панели…"
      />
    );
  }

  return (
    <EmbeddedThreadChat
      threadRef={{ environmentId: primaryEnvironmentId, threadId: state.threadId }}
      variant="compact"
      visibility={visibility satisfies EmbeddedChatVisibility}
      composer
    />
  );
}

function PanelChatNotice({ text, icon }: { text: string; icon?: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center gap-2 px-4 text-center text-muted-foreground text-xs">
      {icon}
      <span>{text}</span>
    </div>
  );
}
