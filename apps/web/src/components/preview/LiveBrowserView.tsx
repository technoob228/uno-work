import {
  ArrowLeftIcon,
  ArrowRightIcon,
  HandIcon,
  KeyRoundIcon,
  MonitorIcon,
  RotateCwIcon,
  UndoIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  BrowserLiveFrame,
  BrowserLiveInputEvent,
  BrowserLivePage,
  CredentialMetadata,
  EnvironmentId,
} from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";

import { readEnvironmentApi } from "../../environmentApi";
import { cn, isMacPlatform } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { matchCredentialsForOrigin } from "./BrowserPane";
import { useBrowserLivePage, useBrowserLiveState } from "./browserLiveStore";
import { browserUrlOrigin, normalizeBrowserUrl } from "./browserUrl";
import type { PreviewFile } from "./PreviewPaneContext";

const IS_MAC = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
/** Без нажатой кнопки движение мыши шлём не чаще, чем раз в столько мс. */
const HOVER_MOVE_INTERVAL_MS = 40;

/**
 * Вкладка браузера самой машины (Work в облаке). Браузер работает на машине —
 * и когда приложение закрыто; здесь его картинка (CDP screencast) и, после
 * «Take control», мышь и клавиатура человека. Пока рулит человек, агент ждёт.
 */
export function LiveBrowserView({ file }: { file: PreviewFile }) {
  const environmentId = (file.environmentId ?? null) as EnvironmentId | null;
  const pageId = file.livePageId ?? null;
  const state = useBrowserLiveState(environmentId);
  const page = useBrowserLivePage(environmentId, pageId);
  const connected = state !== null;
  // readEnvironmentApi собирает новый объект на каждый вызов — держим один на
  // окружение, иначе подписка на кадры пересоздавалась бы на каждую отрисовку.
  const api = useMemo(
    () => (environmentId && connected ? readEnvironmentApi(environmentId) : undefined),
    [environmentId, connected],
  );

  const [frame, setFrame] = useState<BrowserLiveFrame | null>(null);
  useEffect(() => {
    if (!api || !pageId) return;
    setFrame(null);
    return api.browserLive.subscribeFrames({ pageId }, setFrame);
  }, [api, pageId]);

  const human = page?.control === "human";

  const setControl = useCallback(
    async (control: "agent" | "human") => {
      if (!api || !pageId) return;
      try {
        await api.browserLive.setControl({ pageId, control });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't switch control",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [api, pageId],
  );

  if (!environmentId || !pageId) {
    return <Placeholder text="This computer isn't connected." />;
  }
  if (!state || !api) {
    return <Placeholder text="Connecting to the computer's browser…" />;
  }
  if (!page) {
    return <Placeholder text="This page was closed." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar environmentId={environmentId} page={page} human={human} tabId={file.id} />
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
        <MonitorIcon className="size-3 shrink-0" />
        <span className="truncate">
          Runs on {state.location.machine}
          {state.location.publicIp ? ` · IP ${state.location.publicIp}` : ""} · keeps working when
          you close Uno Work
        </span>
      </div>
      {page.help ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <HandIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="font-medium">The agent needs you</div>
            <div className="text-muted-foreground">{page.help.reason}</div>
          </div>
          {human ? (
            <Button size="xs" onClick={() => void setControl("agent")}>
              Done — hand back
            </Button>
          ) : (
            <>
              <Button size="xs" onClick={() => void setControl("human")}>
                Take control
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void setControl("agent")}>
                Done
              </Button>
            </>
          )}
        </div>
      ) : null}
      <Screen
        pageId={pageId}
        environmentId={environmentId}
        frame={frame}
        human={human}
        onTakeControl={() => void setControl("human")}
      />
      <div
        className={cn(
          "flex items-center gap-2 border-t px-3 py-1.5 text-xs",
          human ? "border-primary/40 bg-primary/5" : "border-border",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {human
            ? page.agentWaiting
              ? "You're in control. The agent is waiting for the browser."
              : "You're in control. The agent waits until you hand back."
            : "The agent is using this browser."}
        </span>
        {human ? (
          <Button size="xs" variant="outline" onClick={() => void setControl("agent")}>
            <UndoIcon />
            Hand back
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={() => void setControl("human")}>
            <HandIcon />
            Take control
          </Button>
        )}
      </div>
    </div>
  );
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
      {text}
    </div>
  );
}

function Toolbar({
  environmentId,
  page,
  human,
  tabId,
}: {
  environmentId: EnvironmentId;
  page: BrowserLivePage;
  human: boolean;
  tabId: string;
}) {
  const api = useMemo(() => readEnvironmentApi(environmentId), [environmentId]);
  const [draft, setDraft] = useState(page.url);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(page.url);
  }, [editing, page.url]);

  const navigate = useCallback(
    async (action: "goto" | "back" | "forward" | "reload", url?: string) => {
      if (!api) return;
      try {
        await api.browserLive.navigate({
          pageId: page.pageId,
          action,
          ...(url !== undefined ? { url } : {}),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Couldn't open the page",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [api, page.pageId],
  );

  // Логины из хранилища той же машины: браузер там, пароль туда же и едет.
  const logins = useQuery({
    queryKey: ["browserLiveLogins", environmentId],
    queryFn: async (): Promise<readonly CredentialMetadata[]> =>
      api ? api.browserLive.listLogins() : [],
    staleTime: 10_000,
  });
  const matched = useMemo(
    () =>
      matchCredentialsForOrigin({
        credentials: logins.data,
        origin: browserUrlOrigin(page.url),
      }),
    [logins.data, page.url],
  );

  const fill = useCallback(
    async (credential: CredentialMetadata) => {
      if (!api) return;
      try {
        const result = await api.browserLive.fillLogin({
          id: credential.id,
          tabId,
          ...(page.context?.threadId ? { threadId: page.context.threadId } : {}),
          ...(page.context?.cwd ? { cwd: page.context.cwd } : {}),
        });
        if (!result.filled) {
          toastManager.add({
            type: "warning",
            title: "Couldn't fill the login",
            description: result.error ?? "Open the sign-in form on the page and try again.",
          });
        }
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Logins are unavailable",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [api, page.context?.cwd, page.context?.threadId, tabId],
  );

  const onKeyClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (matched.length === 1) {
        void fill(matched[0]!);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const picked = await readLocalApi()?.contextMenu.show(
        matched.map((credential) => ({ id: credential.id, label: credential.username })),
        { x: rect.left, y: rect.bottom },
      );
      const credential = matched.find((entry) => entry.id === picked);
      if (credential) void fill(credential);
    },
    [fill, matched],
  );

  const navDisabled = !human;
  const navTitle = human ? undefined : "Take control to browse";
  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={navDisabled}
        title={navTitle ?? "Back"}
        aria-label="Back"
        onClick={() => void navigate("back")}
      >
        <ArrowLeftIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={navDisabled}
        title={navTitle ?? "Forward"}
        aria-label="Forward"
        onClick={() => void navigate("forward")}
      >
        <ArrowRightIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        disabled={navDisabled}
        title={navTitle ?? "Reload"}
        aria-label="Reload"
        onClick={() => void navigate("reload")}
      >
        <RotateCwIcon />
      </Button>
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          const url = normalizeBrowserUrl(draft);
          if (!url) return;
          setEditing(false);
          void navigate("goto", url);
        }}
      >
        <input
          value={draft}
          readOnly={!human}
          title={navTitle}
          placeholder={human ? "Type an address" : ""}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(event) => setDraft(event.target.value)}
          className="h-6 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring read-only:text-muted-foreground"
        />
      </form>
      {matched.length > 0 ? (
        <Button
          size="icon-xs"
          variant="ghost"
          title="Fill the saved login"
          aria-label="Fill the saved login"
          onClick={(event) => void onKeyClick(event)}
        >
          <KeyRoundIcon />
        </Button>
      ) : null}
    </div>
  );
}

function modifiersOf(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  return {
    alt: event.altKey,
    ctrl: event.ctrlKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  };
}

function buttonOf(button: number): "left" | "middle" | "right" {
  return button === 1 ? "middle" : button === 2 ? "right" : "left";
}

/**
 * Картинка страницы и ввод. Координаты указателя переводятся в CSS-пиксели
 * страницы по размеру кадра (картинка вписана с сохранением пропорций).
 * События уходят без ожидания ответа — порядок держит сервер.
 */
function Screen({
  environmentId,
  pageId,
  frame,
  human,
  onTakeControl,
}: {
  environmentId: EnvironmentId;
  pageId: string;
  frame: BrowserLiveFrame | null;
  human: boolean;
  onTakeControl: () => void;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const lastHoverRef = useRef(0);
  const [hint, setHint] = useState(false);

  const send = useCallback(
    (event: BrowserLiveInputEvent) => {
      const api = readEnvironmentApi(environmentId);
      void api?.browserLive.input({ pageId, event }).catch(() => undefined);
    },
    [environmentId, pageId],
  );

  const toPage = useCallback(
    (clientX: number, clientY: number) => {
      const image = imageRef.current;
      if (!image || !frame) return null;
      const rect = image.getBoundingClientRect();
      const scale = Math.min(rect.width / frame.width, rect.height / frame.height);
      if (!Number.isFinite(scale) || scale <= 0) return null;
      const offsetX = (rect.width - frame.width * scale) / 2;
      const offsetY = (rect.height - frame.height * scale) / 2;
      const x = (clientX - rect.left - offsetX) / scale;
      const y = (clientY - rect.top - offsetY) / scale;
      if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null;
      return { x: Math.round(x), y: Math.round(y) };
    },
    [frame],
  );

  // Взял управление — фокус на поверхность, чтобы клавиатура сразу шла в страницу.
  useEffect(() => {
    if (human) surfaceRef.current?.focus();
    setHint(false);
  }, [human]);

  const keyFor = (event: React.KeyboardEvent) =>
    // На Маке Cmd — это Ctrl страницы на Linux: Cmd+A/C/X/Z работают как ждёшь.
    IS_MAC && event.key === "Meta" ? "Control" : event.key;

  return (
    <div
      ref={surfaceRef}
      tabIndex={0}
      className={cn(
        "relative min-h-0 flex-1 select-none overflow-hidden bg-muted/40 outline-none",
        human && "ring-2 ring-inset ring-primary/60",
      )}
      onPointerDown={(event) => {
        if (!human) {
          setHint(true);
          return;
        }
        surfaceRef.current?.focus();
        const point = toPage(event.clientX, event.clientY);
        if (!point) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        send({
          type: "mouse",
          action: "down",
          ...point,
          button: buttonOf(event.button),
          clickCount: Math.max(1, event.detail),
          modifiers: modifiersOf(event),
        });
      }}
      onPointerUp={(event) => {
        if (!human) return;
        const point = toPage(event.clientX, event.clientY);
        if (!point) return;
        send({
          type: "mouse",
          action: "up",
          ...point,
          button: buttonOf(event.button),
          clickCount: Math.max(1, event.detail),
          modifiers: modifiersOf(event),
        });
      }}
      onPointerMove={(event) => {
        if (!human) return;
        const dragging = event.buttons !== 0;
        const now = performance.now();
        if (!dragging && now - lastHoverRef.current < HOVER_MOVE_INTERVAL_MS) return;
        lastHoverRef.current = now;
        const point = toPage(event.clientX, event.clientY);
        if (!point) return;
        send({ type: "mouse", action: "move", ...point, modifiers: modifiersOf(event) });
      }}
      onWheel={(event) => {
        if (!human) return;
        const point = toPage(event.clientX, event.clientY);
        if (!point) return;
        send({ type: "wheel", ...point, deltaX: event.deltaX, deltaY: event.deltaY });
      }}
      onContextMenu={(event) => {
        if (human) event.preventDefault();
      }}
      onKeyDown={(event) => {
        if (!human) return;
        // Вставку отдаёт событие paste — там текст из буфера этого устройства.
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
        event.preventDefault();
        send({ type: "key", action: "down", key: keyFor(event), code: event.code });
      }}
      onKeyUp={(event) => {
        if (!human) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
        event.preventDefault();
        send({ type: "key", action: "up", key: keyFor(event), code: event.code });
      }}
      onPaste={(event) => {
        if (!human) return;
        const text = event.clipboardData.getData("text/plain");
        if (!text) return;
        event.preventDefault();
        send({ type: "text", text });
      }}
    >
      {frame ? (
        <img
          ref={imageRef}
          src={`data:image/jpeg;base64,${frame.data}`}
          alt=""
          draggable={false}
          className="pointer-events-none h-full w-full object-contain"
        />
      ) : (
        <Placeholder text="Loading the page…" />
      )}
      {hint && !human ? (
        <div className="absolute inset-x-0 bottom-3 flex justify-center">
          <div className="flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
            <span>The agent is using this browser.</span>
            <Button
              size="xs"
              onClick={(event) => {
                event.stopPropagation();
                onTakeControl();
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              Take control
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
