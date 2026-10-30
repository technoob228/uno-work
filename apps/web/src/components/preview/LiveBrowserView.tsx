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
  BrowserLiveLocation,
  BrowserLivePage,
  BrowserLiveSetup,
  CredentialMetadata,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { BROWSER_LIVE_SETUP_PAGE_ID } from "@t3tools/contracts";
import { personMachineName } from "@t3tools/shared/machineName";
import { useQuery } from "@tanstack/react-query";

import { readEnvironmentApi } from "../../environmentApi";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { selectThreadByRef, useStore } from "../../store";
import { cn, isMacPlatform } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { useSidebarEnvironmentLabelResolver } from "../sidebar/useSidebarMachineIdentities";
import { matchCredentialsForOrigin } from "./BrowserPane";
import { BrowserHelpCard } from "./BrowserHelpCard";
import { LiveBrowserOpenOutside } from "./LiveBrowserOpenOutside";
import { BrowserSourceChip } from "./BrowserSourceChip";
import { CommentBar, CommentLayer, SelectionQuote } from "./annotate/CommentLayer";
import { PAGE_SELECTION_EXPRESSION, pageSelectionFrom } from "./annotate/pageToolsScript";
import { DebugDrawer } from "./annotate/DebugDrawer";
import { boxPointToPage, fitFrame } from "./annotate/liveFrame.logic";
import { LivePageView } from "./annotate/liveWebview";
import { DevToolsButton } from "./annotate/DevToolsButton";
import { BrowserMenu } from "./BrowserMenu";
import { usePageToolsStore, usePageToolsTab } from "./annotate/pageToolsStore";
import { usePageTools } from "./annotate/usePageTools";
import { isTypingTarget } from "./panelLauncher.logic";
import { useBrowserLivePage, useBrowserLiveState, useBrowserOpenError } from "./browserLiveStore";
import { useChatBrowser } from "./useChatBrowser";
import { browserUrlOrigin, normalizeBrowserUrl } from "./browserUrl";
import { isBlankPageUrl } from "./yourBrowserTab.logic";
import type { PreviewFile } from "./PreviewPaneContext";

const IS_MAC = typeof navigator !== "undefined" && isMacPlatform(navigator.platform);
/** Без нажатой кнопки движение мыши шлём не чаще, чем раз в столько мс. */
const HOVER_MOVE_INTERVAL_MS = 40;

/**
 * Is the agent at the browser right now? Only while the chat that opened the
 * page is working. A page with no known chat (older daemon, another client's
 * chat not loaded here) keeps the old answer — "yes".
 */
export function agentUsesBrowser(
  ownerThreadId: string | null,
  ownerOrchestrationStatus: string | null,
): boolean {
  if (!ownerThreadId || ownerOrchestrationStatus === null) return true;
  return ownerOrchestrationStatus === "running" || ownerOrchestrationStatus === "starting";
}

/**
 * Вкладка браузера самой машины (Work в облаке). Браузер работает на машине —
 * и когда приложение закрыто; здесь его картинка (CDP screencast) и, после
 * «Take control», мышь и клавиатура человека. Пока рулит человек, агент ждёт.
 *
 * `mine` — своя вкладка человека в веб-версии (YourBrowserTab, п.14): страница
 * не чата, рулит человек с самого начала — ни «Take control», ни строки про
 * агента; «Open in my browser» и расширение — под страницей, у вкладки.
 */
export function LiveBrowserView({ file, mine = false }: { file: PreviewFile; mine?: boolean }) {
  const environmentId = (file.environmentId ?? null) as EnvironmentId | null;
  const pageId = file.livePageId ?? null;
  const state = useBrowserLiveState(environmentId);
  const page = useBrowserLivePage(environmentId, pageId);
  const openError = useBrowserOpenError(environmentId);
  const { openInSource } = useChatBrowser();
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
    // Only this page's pictures, whatever else the stream carries.
    return api.browserLive.subscribeFrames({ pageId }, (next) => {
      if (next.pageId === pageId) setFrame(next);
    });
  }, [api, pageId]);

  const human = page?.control === "human";
  // Two browsers (Labs `panelLauncherV2`, w0138 16.10): the help card instead
  // of the amber strip, no "Opens in" chip. Off — as in 0.0.137.
  const launcherV2 = useFeatureFlag("panelLauncherV2");
  // "The agent is using this browser" only while its chat is actually working:
  // after the turn the line used to stay forever (flows v2, life-work-full/6).
  const ownerThreadId = page?.context?.threadId ?? null;
  const ownerStatus = useStore((store) =>
    environmentId && ownerThreadId
      ? (selectThreadByRef(store, {
          environmentId,
          threadId: ownerThreadId as ThreadId,
        })?.session?.orchestrationStatus ?? null)
      : null,
  );
  const agentBusy = agentUsesBrowser(ownerThreadId, ownerStatus);

  // Comment (flag `browserPageTools`, Misha 16.10 p.12): like "Your site" in
  // the Mac app, on the desktop and on the web. The page script goes into the
  // computer's page the first time Comment is turned on here (not into every
  // page the agent opens), and stays with the tab after that.
  const tabId = file.id;
  const pageToolsOn = useFeatureFlag("browserPageTools");
  const pageTools = usePageToolsTab(tabId);
  const wantsTools =
    pageToolsOn &&
    pageId !== null &&
    pageId !== BROWSER_LIVE_SETUP_PAGE_ID &&
    (pageTools.devtools || pageTools.commenting || pageTools.comments.length > 0);
  const [toolsActivated, setToolsActivated] = useState(false);
  useEffect(() => {
    if (wantsTools) setToolsActivated(true);
  }, [wantsTools]);
  const [liveView, setLiveView] = useState<LivePageView | null>(null);
  useEffect(() => {
    if (!toolsActivated || !pageToolsOn || !api || !pageId) return;
    if (pageId === BROWSER_LIVE_SETUP_PAGE_ID) return;
    const view = new LivePageView(api.browserLive, pageId);
    setLiveView(view);
    return () => {
      view.dispose();
      setLiveView(null);
    };
  }, [toolsActivated, pageToolsOn, api, pageId]);
  const capture = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) =>
      liveView ? liveView.capture(rect) : Promise.resolve(null),
    [liveView],
  );
  usePageTools({ tabId, view: liveView, enabled: liveView !== null, capture });
  useEffect(() => {
    liveView?.setFast(pageTools.commenting);
  }, [liveView, pageTools.commenting]);
  // C and Esc, as in "Your site": while the focus is in this tab, not typing.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!pageToolsOn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || !rootRef.current?.contains(target) || isTypingTarget(target)) return;
      const store = usePageToolsStore.getState();
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "c") store.toggleMode(tabId);
      else if (key !== "Escape" || !store.escape(tabId)) return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pageToolsOn, tabId]);

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
  if (pageId === BROWSER_LIVE_SETUP_PAGE_ID && openError) {
    return <BrowserOpenErrorView error={openError} onRetry={() => openInSource("computer")} />;
  }
  if (pageId === BROWSER_LIVE_SETUP_PAGE_ID || (!page && state.setup.status !== "ready")) {
    return <BrowserSetupView environmentId={environmentId} setup={state.setup} />;
  }
  if (!page) {
    return <Placeholder text="This page was closed." />;
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <Toolbar
        environmentId={environmentId}
        page={page}
        human={human}
        tabId={file.id}
        sourceChip={!launcherV2 && !mine}
        pageToolsOn={pageToolsOn}
        mine={mine}
      />
      <LocationStrip environmentId={environmentId} location={state.location} />
      {mine ? null : launcherV2 ? (
        // Sign-in, captcha, 2FA: the same card as above the chat's composer.
        <BrowserHelpCard environmentId={environmentId} page={page} where="panel" />
      ) : page.help ? (
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
        agentBusy={agentBusy}
        onTakeControl={() => void setControl("human")}
        tabId={tabId}
        tools={pageToolsOn ? liveView : null}
        commenting={pageToolsOn && pageTools.commenting}
        // A new tab of one's own: the address bar has the focus, not the page.
        focusOnControl={!(mine && isBlankPageUrl(page.url))}
      />
      {pageToolsOn ? <CommentBar tabId={tabId} pageUrl={page.url} /> : null}
      {pageToolsOn && pageTools.devtools ? <DebugDrawer tabId={tabId} pageUrl={page.url} /> : null}
      <div
        hidden={mine || (launcherV2 && page.help !== null)}
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
            : agentBusy
              ? "The agent is using this browser."
              : "The agent is done here. Take control to use this browser yourself."}
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

/** "Runs on …": the sidebar's name of the computer, else the daemon's own, never a service name. */
export function browserMachineName(
  environmentLabel: string | null | undefined,
  daemonMachine: string | null | undefined,
): string {
  return personMachineName(environmentLabel) ?? personMachineName(daemonMachine) ?? "this computer";
}

function hostOf(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/**
 * Где работает браузер: машина, адрес и страна, которые видят сайты, и прокси.
 * Прокси меняется здесь же — браузер перезапускается, логины остаются.
 */
function LocationStrip({
  environmentId,
  location,
}: {
  environmentId: EnvironmentId;
  location: BrowserLiveLocation;
}) {
  const [editing, setEditing] = useState(false);
  const [server, setServer] = useState(location.proxy?.server ?? "");
  const [username, setUsername] = useState(location.proxy?.username ?? "");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (next: { server: string; username?: string; password?: string }) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    setSaving(true);
    try {
      await api.browserLive.setProxy(next);
      setEditing(false);
      setPassword("");
      toastManager.add({
        type: "success",
        title: next.server ? "Proxy saved" : "Proxy removed",
        description: "The browser restarted. Saved logins stay.",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't save the proxy",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const address = location.publicIp
    ? `IP ${location.publicIp}${location.country ? ` (${location.country})` : ""}`
    : null;
  // The computer by the name the person knows it by (the one in the sidebar),
  // never the host or image name the daemon happens to run under.
  const resolveEnvironmentLabel = useSidebarEnvironmentLabelResolver();
  const machine = browserMachineName(resolveEnvironmentLabel(environmentId), location.machine);
  // With the new launcher (`panelLauncherV2`) the line is short: the address
  // and the proxy go to its tooltip. Without it — as in 0.0.137.
  const compact = useFeatureFlag("panelLauncherV2");
  return (
    <div className="border-b border-border px-2 py-1 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5">
        <MonitorIcon className="size-3 shrink-0" />
        {compact ? (
          // The address and the proxy are for the curious: in the tooltip (w0138).
          <span
            className="min-w-0 flex-1 truncate"
            title={[
              address,
              location.proxy ? `via ${hostOf(location.proxy.server)}` : null,
              "Keeps working when you close Uno Work",
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            Runs on {machine}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate">
            Runs on {machine}
            {address ? ` · ${address}` : ""}
            {location.proxy ? ` · via ${hostOf(location.proxy.server)}` : ""} · keeps working when
            you close Uno Work
          </span>
        )}
        <button
          type="button"
          className="shrink-0 rounded px-1 hover:bg-accent hover:text-foreground"
          onClick={() => setEditing((value) => !value)}
        >
          {location.proxy ? "Proxy" : "Add proxy"}
        </button>
      </div>
      {editing ? (
        <form
          className="mt-1.5 flex flex-wrap items-center gap-1.5 pb-1"
          onSubmit={(event) => {
            event.preventDefault();
            void save({
              server: server.trim(),
              ...(username.trim() ? { username: username.trim() } : {}),
              ...(password ? { password } : {}),
            });
          }}
        >
          <input
            value={server}
            onChange={(event) => setServer(event.target.value)}
            placeholder="http://host:port"
            className="h-6 min-w-40 flex-1 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none"
          />
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Login"
            autoComplete="off"
            className="h-6 w-24 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none"
          />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={location.proxy ? "Password (kept)" : "Password"}
            type="password"
            autoComplete="new-password"
            className="h-6 w-28 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none"
          />
          <Button size="xs" type="submit" disabled={saving || server.trim() === ""}>
            Save
          </Button>
          {location.proxy ? (
            <Button
              size="xs"
              variant="ghost"
              type="button"
              disabled={saving}
              onClick={() => void save({ server: "" })}
            >
              Remove
            </Button>
          ) : null}
          <span className="basis-full text-[11px]">
            Sites will see the proxy's address. Use the proxy of the country your accounts live in.
          </span>
        </form>
      ) : null}
    </div>
  );
}

function formatWait(seconds: number): string {
  return seconds >= 90 ? `~${Math.round(seconds / 60)} min` : `~${Math.max(10, seconds)} s`;
}

/**
 * Браузера машины нет в образе Work — он ставится при первом открытии (агентом
 * или человеком). Здесь прогресс и «Try again» после неудачи; страница чата
 * откроется сама, когда браузер встанет.
 */
function BrowserSetupView({
  environmentId,
  setup,
}: {
  environmentId: EnvironmentId;
  setup: BrowserLiveSetup;
}) {
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await readEnvironmentApi(environmentId)?.browserLive.setup();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't set up the browser",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRetrying(false);
    }
  }, [environmentId]);

  if (setup.status === "ready") {
    return <Placeholder text="The browser is ready. Opening the page…" />;
  }
  if (setup.status === "failed") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <MonitorIcon className="size-6 text-muted-foreground" />
        <div className="font-medium">Couldn't set up the browser</div>
        <div className="max-w-sm text-muted-foreground">{setup.error}</div>
        <Button size="sm" disabled={retrying} onClick={() => void retry()}>
          {retrying ? <Spinner /> : <RotateCwIcon />}
          Try again
        </Button>
      </div>
    );
  }
  if (setup.status === "missing") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <MonitorIcon className="size-6 text-muted-foreground" />
        <div className="max-w-sm text-muted-foreground">
          This computer's browser isn't set up yet. It takes about a minute, once.
        </div>
        <Button size="sm" disabled={retrying} onClick={() => void retry()}>
          Set up the browser
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm">
      <Spinner className="size-6 text-muted-foreground" />
      <div className="font-medium">
        Setting up the browser… {formatWait(setup.secondsLeft ?? 45)}
      </div>
      <div className="max-w-sm text-muted-foreground">
        {setup.step ? `${setup.step}. ` : ""}This happens once on this computer. The page opens by
        itself when it's ready — you can keep working.
      </div>
    </div>
  );
}

/** The person's Browser click failed on the computer: say so here, with Try again. */
function BrowserOpenErrorView({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
      data-testid="browser-open-error"
    >
      <MonitorIcon className="size-6 text-muted-foreground" />
      <div className="font-medium">The computer's browser didn't start</div>
      <div className="max-w-sm text-xs break-words text-muted-foreground">{error}</div>
      <Button size="sm" onClick={onRetry}>
        <RotateCwIcon />
        Try again
      </Button>
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
  sourceChip,
  pageToolsOn,
  mine,
}: {
  environmentId: EnvironmentId;
  page: BrowserLivePage;
  human: boolean;
  tabId: string;
  /** The person's own tab: "Open in my browser" is under the page, not here. */
  mine: boolean;
  /** The "Opens in" chip of 0.0.135–0.0.137 (without Labs `panelLauncherV2`). */
  sourceChip: boolean;
  /** Comment in the bar (flag `browserPageTools`), on the desktop and on the web. */
  pageToolsOn: boolean;
}) {
  const api = useMemo(() => readEnvironmentApi(environmentId), [environmentId]);
  // A blank page shows an empty address bar, not "about:blank".
  const shownUrl = isBlankPageUrl(page.url) ? "" : page.url;
  const [draft, setDraft] = useState(shownUrl);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(shownUrl);
  }, [editing, shownUrl]);

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
          // Адрес — сама страница машины (в т.ч. попап входа), не вкладка панели.
          tabId: page.pageId,
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
    [api, page.context?.cwd, page.context?.threadId, page.pageId],
  );

  const onKeyClick = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      if (matched.length === 1) {
        void fill(matched[0]!);
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      const picked = await readLocalApi()?.contextMenu.show(
        matched.map((credential) => ({
          id: credential.id,
          label: credential.username,
        })),
        { x: rect.left, y: rect.bottom },
      );
      const credential = matched.find((entry) => entry.id === picked);
      if (credential) void fill(credential);
    },
    [fill, matched],
  );

  const navDisabled = !human;
  const navTitle = human ? undefined : "Take control to browse";
  const pageTools = usePageToolsTab(tabId);
  const devtools = {
    open: pageTools.devtools,
    commenting: pageTools.commenting,
  };
  return (
    <div
      className={cn(
        "flex items-center gap-1 border-b border-border px-2",
        pageToolsOn ? "h-8 shrink-0" : "py-1",
      )}
    >
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
      {sourceChip ? <BrowserSourceChip source="computer" tabId={tabId} url={page.url} /> : null}
      <form
        className="min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          const url = normalizeBrowserUrl(draft);
          if (!url) return;
          setEditing(false);
          // The keyboard goes back to the page, as in a browser.
          (event.currentTarget.elements.namedItem("address") as HTMLInputElement | null)?.blur();
          void navigate("goto", url);
        }}
      >
        <input
          name="address"
          value={draft}
          readOnly={!human}
          title={navTitle}
          placeholder={human ? "Type an address" : ""}
          autoFocus={mine && shownUrl === ""}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(event) => setDraft(event.target.value)}
          className="h-6 w-full rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring read-only:text-muted-foreground"
        />
      </form>
      {/* Developer tools (Misha 28.10): the same </> as in "Your site"; the
          page script goes into the computer's page once they're opened (liveWebview.ts). */}
      {pageToolsOn ? <DevToolsButton tabId={tabId} disabled={false} /> : null}
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
      <BrowserMenu
        logins={matched}
        onFillLogin={(credential) => void fill(credential)}
        {...(pageToolsOn
          ? {
              devtools: {
                open: devtools.open,
                commenting: devtools.commenting,
                onToggle: () => usePageToolsStore.getState().toggleDevtools(tabId),
                onComment: () => usePageToolsStore.getState().toggleMode(tabId),
              },
            }
          : {})}
        {...(human ? { onHardReload: () => void navigate("reload") } : {})}
      />
      {mine ? null : <LiveBrowserOpenOutside environmentId={environmentId} pageUrl={page.url} />}
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
  agentBusy,
  onTakeControl,
  tabId,
  tools,
  commenting,
  focusOnControl = true,
}: {
  environmentId: EnvironmentId;
  pageId: string;
  frame: BrowserLiveFrame | null;
  human: boolean;
  /** The chat that opened the page is working right now. */
  agentBusy: boolean;
  onTakeControl: () => void;
  /** The browser tab (Comment's state is by tab). */
  tabId: string;
  /** Comment's way into the page; null — Comment is off for this tab. */
  tools: LivePageView | null;
  /**
   * Comment mode: the person's pointer goes to Comment (highlight, pick,
   * Shift+drag for an area) — with or without "Take control", the agent's
   * page never gets these clicks.
   */
  commenting: boolean;
  /** Taking control puts the keyboard into the page (not for a new tab's address bar). */
  focusOnControl?: boolean;
}) {
  const imageRef = useRef<HTMLImageElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // The picture inside the box: Comment's note box is placed against it.
  const pictureRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const measure = () => {
      const { width, height } = surface.getBoundingClientRect();
      setBox((current) =>
        current && current.width === width && current.height === height
          ? current
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  const drafting = usePageToolsTab(tabId).draft !== null;
  const commentDragRef = useRef<{ x: number; y: number } | null>(null);
  const lastCommentMoveRef = useRef(0);
  const lastHoverRef = useRef(0);
  // У pointer-событий detail всегда 0: двойной/тройной клик считаем сами,
  // иначе выделение слова и строки на странице не работает.
  const clickRef = useRef({ at: 0, x: 0, y: 0, count: 0 });
  const [hint, setHint] = useState(false);
  // `panelLauncherV2`: the picture sits at the top (no band of empty space
  // above it); without the flag — centred, as in 0.0.137.
  const pinTop = useFeatureFlag("panelLauncherV2");

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
      const fit = fitFrame(rect, frame, pinTop);
      if (!fit) return null;
      return boxPointToPage({ x: clientX - rect.left, y: clientY - rect.top }, fit, frame);
    },
    [frame, pinTop],
  );
  const fit = frame && box ? fitFrame(box, frame, pinTop) : null;
  // Comment mode takes the pointer while there's no note being written.
  const commentPointer = commenting && tools !== null;

  // Взял управление — фокус на поверхность, чтобы клавиатура сразу шла в страницу.
  const focusOnControlRef = useRef(focusOnControl);
  focusOnControlRef.current = focusOnControl;
  useEffect(() => {
    if (human && focusOnControlRef.current) surfaceRef.current?.focus();
    setHint(false);
  }, [human]);

  // Пока рулит человек, страница под размер панели — 1:1, без мелкой картинки.
  // Вернул агенту — сервер сам возвращает агентский размер.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!human || !surface) return;
    const api = readEnvironmentApi(environmentId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fit = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const { width, height } = surface.getBoundingClientRect();
        if (width < 50 || height < 50) return;
        void api?.browserLive
          .resize({
            pageId,
            width: Math.round(width),
            height: Math.round(height),
          })
          .catch(() => undefined);
      }, 250);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(surface);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [environmentId, human, pageId]);

  // Selected on the page while the person drives: the same Quote as on their
  // own site. Asked once per mouse up; nothing is put into the agent's page.
  const readSelection = useCallback(() => {
    const api = readEnvironmentApi(environmentId);
    void api?.browserLive
      .evaluate({ pageId, expression: PAGE_SELECTION_EXPRESSION })
      .then(({ json }) => {
        const selection = pageSelectionFrom(json === null ? null : JSON.parse(json));
        usePageToolsStore.getState().patch(tabId, { selection });
      })
      .catch(() => undefined);
  }, [environmentId, pageId, tabId]);

  // Выделенное на странице — в буфер этого устройства (Cmd/Ctrl+C и +X).
  const copyToClipboard = useCallback(async () => {
    const api = readEnvironmentApi(environmentId);
    const result = await api?.browserLive.copySelection({ pageId }).catch(() => null);
    if (result?.text) await navigator.clipboard?.writeText(result.text).catch(() => undefined);
  }, [environmentId, pageId]);
  // Клавиша, чьё отпускание уже отправлено вручную (вырезание).
  const swallowKeyUpRef = useRef<string | null>(null);

  const keyFor = (event: React.KeyboardEvent) =>
    // На Маке Cmd — это Ctrl страницы на Linux: Cmd+A/C/X/Z работают как ждёшь.
    IS_MAC && event.key === "Meta" ? "Control" : event.key;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={surfaceRef}
        tabIndex={0}
        data-testid="live-browser-screen"
        className={cn(
          "relative min-h-0 flex-1 select-none overflow-hidden bg-muted/40 outline-none",
          human && "ring-2 ring-inset ring-primary/60",
          commentPointer && !drafting && "cursor-crosshair",
        )}
        onPointerDown={(event) => {
          if (commentPointer) {
            surfaceRef.current?.focus();
            if (drafting || event.button !== 0) return;
            const point = toPage(event.clientX, event.clientY);
            if (!point) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            commentDragRef.current = event.shiftKey ? point : null;
            return;
          }
          if (!human) {
            setHint(true);
            return;
          }
          surfaceRef.current?.focus();
          const point = toPage(event.clientX, event.clientY);
          if (!point) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const last = clickRef.current;
          const now = performance.now();
          const repeat =
            now - last.at < 500 && Math.abs(point.x - last.x) < 5 && Math.abs(point.y - last.y) < 5;
          clickRef.current = {
            at: now,
            ...point,
            count: repeat ? last.count + 1 : 1,
          };
          send({
            type: "mouse",
            action: "down",
            ...point,
            button: buttonOf(event.button),
            clickCount: clickRef.current.count,
            modifiers: modifiersOf(event),
          });
        }}
        onPointerUp={(event) => {
          if (commentPointer) {
            const start = commentDragRef.current;
            commentDragRef.current = null;
            if (drafting || event.button !== 0) return;
            const point = toPage(event.clientX, event.clientY);
            if (!point) return;
            if (start) tools.pointer("areaAt", [start.x, start.y, point.x, point.y]);
            else tools.pointer("pickAt", [point.x, point.y]);
            return;
          }
          if (!human) return;
          const point = toPage(event.clientX, event.clientY);
          if (!point) return;
          send({
            type: "mouse",
            action: "up",
            ...point,
            button: buttonOf(event.button),
            clickCount: Math.max(1, clickRef.current.count),
            modifiers: modifiersOf(event),
          });
          if (event.button === 0) window.setTimeout(readSelection, 120);
        }}
        onPointerMove={(event) => {
          if (commentPointer) {
            if (drafting) return;
            const now = performance.now();
            if (now - lastCommentMoveRef.current < HOVER_MOVE_INTERVAL_MS) return;
            lastCommentMoveRef.current = now;
            const point = toPage(event.clientX, event.clientY);
            if (!point) return;
            const start = commentDragRef.current;
            if (start) tools.pointer("dragAt", [start.x, start.y, point.x, point.y]);
            else tools.pointer("hoverAt", [point.x, point.y]);
            return;
          }
          if (!human) return;
          const dragging = event.buttons !== 0;
          const now = performance.now();
          if (!dragging && now - lastHoverRef.current < HOVER_MOVE_INTERVAL_MS) return;
          lastHoverRef.current = now;
          const point = toPage(event.clientX, event.clientY);
          if (!point) return;
          send({
            type: "mouse",
            action: "move",
            ...point,
            modifiers: modifiersOf(event),
          });
        }}
        onWheel={(event) => {
          // Comment mode without control: the page still scrolls (its pins follow).
          if (commentPointer && !human) {
            tools.scrollBy(event.deltaX, event.deltaY);
            return;
          }
          if (!human) return;
          const point = toPage(event.clientX, event.clientY);
          if (!point) return;
          send({
            type: "wheel",
            ...point,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          });
        }}
        onContextMenu={(event) => {
          if (human) event.preventDefault();
        }}
        onKeyDown={(event) => {
          // C and Esc are Comment's while it's on (the tab's handler takes them).
          if (commenting && (event.key === "Escape" || event.key.toLowerCase() === "c")) return;
          if (!human) return;
          // Вставку отдаёт событие paste — там текст из буфера этого устройства.
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
          event.preventDefault();
          const shortcut = (event.metaKey || event.ctrlKey) && !event.altKey;
          const letter = event.key.toLowerCase();
          if (shortcut && letter === "x") {
            // Вырезание убирает выделение — сначала забираем текст, потом жмём.
            const key = keyFor(event);
            swallowKeyUpRef.current = key;
            void copyToClipboard().finally(() => {
              send({ type: "key", action: "down", key, code: event.code });
              send({ type: "key", action: "up", key, code: event.code });
            });
            return;
          }
          send({
            type: "key",
            action: "down",
            key: keyFor(event),
            code: event.code,
          });
          if (shortcut && letter === "c") void copyToClipboard();
        }}
        onKeyUp={(event) => {
          if (!human) return;
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
          event.preventDefault();
          if (swallowKeyUpRef.current === keyFor(event)) {
            swallowKeyUpRef.current = null;
            return;
          }
          send({
            type: "key",
            action: "up",
            key: keyFor(event),
            code: event.code,
          });
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
            className={cn(
              "pointer-events-none h-full w-full object-contain",
              pinTop && "object-top",
            )}
          />
        ) : (
          <Placeholder text="Loading the page…" />
        )}
        {fit ? (
          <div
            ref={pictureRef}
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: fit.offsetX,
              top: fit.offsetY,
              width: fit.width,
              height: fit.height,
            }}
          />
        ) : null}
        {hint && !human && !commenting ? (
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <div className="flex items-center gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
              <span>
                {agentBusy
                  ? "The agent is using this browser."
                  : "Take control to use this browser."}
              </span>
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
      {tools ? <CommentLayer tabId={tabId} pageRef={pictureRef} zoom={fit?.scale ?? 1} /> : null}
      <SelectionQuote tabId={tabId} pageRef={pictureRef} zoom={fit?.scale ?? 1} />
    </div>
  );
}
