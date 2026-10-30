/**
 * The assistants base (28.10): the floating "what to look at" card — the
 * account's state (switches reload the demo in that world) and the scenes
 * (things that happen without the person typing). Only in `VITE_DEMO=assist`.
 * Playwright drives the same through `window.__assistDemo` (e2e/README).
 */
import { demoVault } from "./vault";
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";
import { ChevronDownIcon, EyeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { waitForThreadInStore } from "../../assistant/useAssistantChat";
import type { getRouter } from "../../router";
import { assistDemo } from "../demoBoot";
import type { MachineKey } from "../heavyFixtures";
import { demoReady, listScenes, play } from "./engine";
import { personaOf } from "./daemon";
import { VARIANT } from "./variant";
import { MC_VARIANT } from "./mcVariant";
import { dropLink, wakeComputer } from "./links";
import {
  type AssistWorld,
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  type ConnectorState,
  WORLD,
  switchWorld,
} from "./world";

type DemoRouter = ReturnType<typeof getRouter>;

const ROWS: ReadonlyArray<{
  readonly key: Exclude<keyof AssistWorld, "connectors">;
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}> = [
  {
    key: "account",
    label: "Аккаунт",
    options: [
      { id: "live", name: "Живой" },
      { id: "new", name: "Новый (пусто)" },
    ],
  },
  {
    key: "tier",
    label: "Тариф",
    options: [
      { id: "plus", name: "Plus" },
      { id: "free", name: "Free" },
    ],
  },
  {
    key: "mac",
    label: "MacBook",
    options: [
      { id: "online", name: "Онлайн" },
      { id: "asleep", name: "Спит" },
      { id: "flaky", name: "Отваливается" },
      { id: "offline", name: "Нет связи" },
    ],
  },
  {
    key: "spaces",
    label: "Простр.",
    options: [
      { id: "off", name: "Выкл (вариант C)" },
      { id: "on", name: "Вкл — машина = своя вселенная" },
    ],
  },
  {
    key: "load",
    label: "uno-work",
    options: [
      { id: "normal", name: "Обычная нагрузка" },
      { id: "busy", name: "Загружен" },
    ],
  },
  {
    key: "telegram",
    label: "Telegram",
    options: [
      { id: "on", name: "Связан" },
      { id: "off", name: "Нет" },
    ],
  },
  {
    key: "mode",
    label: "Режим",
    options: [
      { id: "itself", name: "Всё сам" },
      { id: "asks-first", name: "Спрашивает" },
    ],
  },
  {
    key: "platform",
    label: "Work",
    options: [
      { id: "cloud", name: "В браузере" },
      { id: "desktop", name: "Десктоп" },
    ],
  },
  {
    key: "automations",
    label: "Автоматиз.",
    options: [
      { id: "some", name: "Есть" },
      { id: "none", name: "Нет" },
    ],
  },
  {
    key: "gh",
    label: "GitHub app",
    options: [
      { id: "ok", name: "Видит" },
      { id: "norepo", name: "Нет репо" },
      { id: "noperm", name: "Нет прав" },
      { id: "off", name: "Нет" },
    ],
  },
];

const CONNECTOR_LABEL: Record<ConnectorProvider, string> = {
  gmail: "Gmail+Cal",
  "google-drive": "Drive",
  notion: "Notion",
  github: "GitHub",
};
const STATE_LABEL: Record<ConnectorState, string> = { on: "вкл", off: "нет", expired: "истёк" };

function Chip(props: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
  readonly testId: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid={props.testId}
      aria-pressed={props.active}
      className={cn(
        "cursor-pointer rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
        props.active
          ? "border-foreground/70 bg-foreground/5 text-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

/** Opens the assistant's main chat and plays the scene there. */
export async function runScene(
  router: DemoRouter | null,
  sceneId: string,
  target: { machine?: MachineKey; projectId?: string } | null = null,
) {
  const scene = listScenes().find((item) => item.id === sceneId);
  if (!scene) throw new Error(`No scene ${sceneId}`);
  const machine = target?.machine ?? scene.target?.machine ?? "work";
  const projectId = target?.projectId ?? scene.target?.projectId ?? ASSISTANT_PROJECT_ID;
  const persona = personaOf(machine, projectId);
  if (!persona) throw new Error(`No assistant ${projectId} on ${machine}`);
  const threadId = assistDemo.mainChat(machine, projectId);
  await router?.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: assistDemo.environmentOf(machine), threadId },
  } as never);
  scene.run({
    ops: assistDemo.ops,
    world: WORLD,
    target: { machine, threadId, persona },
    play: (script) => play(machine, threadId, script),
  });
}

export default function AssistPanel({ router }: { router: DemoRouter }) {
  const [open, setOpen] = useState(() =>
    typeof window === "undefined"
      ? true
      : window.innerWidth >= 900 && !/[?&]panel=closed/.test(location.search),
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__assistDemo = {
      world: WORLD,
      scenes: () => listScenes().map((scene) => scene.id),
      scene: (id: string, target?: { machine?: MachineKey; projectId?: string }) =>
        runScene(router, id, target),
      mainChat: (machine?: MachineKey, projectId?: string) =>
        assistDemo.mainChat(machine, projectId),
      environmentOf: assistDemo.environmentOf,
      vault: (machine: MachineKey) => demoVault(assistDemo.environmentOf(machine)),
      /** Opens a page of the app the way its own links do (flows). */
      go: (to: string, search?: Record<string, string>) =>
        void router.navigate({ to, ...(search ? { search } : {}) } as never),
      switchWorld,
    };
    demoReady({
      hash: location.hash,
      openChat: (machine, threadId) => {
        const environmentId = assistDemo.environmentOf(machine);
        // A chat made just now: wait until it reaches the page, like the real app does.
        void waitForThreadInStore(environmentId as never, threadId as never, 5_000).then(
          () =>
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId },
            } as never),
        );
      },
    });
  }, [router]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="demo-panel-pill"
        className="fixed top-1/2 left-[16rem] z-[90] inline-flex translate-x-1 -translate-y-1/2 cursor-pointer flex-row items-center gap-1.5 rounded-full border border-border bg-popover px-1 py-2.5 text-[11px] font-medium text-popover-foreground shadow-lg [writing-mode:vertical-rl] hover:bg-accent"
      >
        <EyeIcon className="size-3.5" />
        Что смотреть
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Что смотреть"
      data-testid="demo-panel"
      className="fixed top-1/2 left-[16.75rem] z-[90] flex max-h-[calc(100vh-1.25rem)] w-[min(26rem,calc(100vw-1.5rem))] -translate-y-1/2 flex-col rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Несколько компьютеров · {MC_VARIANT.title}</div>
          <div className="text-[11px] leading-snug text-muted-foreground">{MC_VARIANT.hint}</div>
          <div className="text-[11px] text-muted-foreground">
            Настоящий Uno Work · данные выдуманные, ничего не уходит наружу · ассистенты:{" "}
            {VARIANT.title}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Свернуть"
          className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDownIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto px-3.5 pb-3">
        <div className="mt-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Состояние
        </div>
        {ROWS.map((row) => (
          <div key={row.key} className="mt-1.5 flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-[11px] text-muted-foreground">{row.label}</span>
            {row.options.map((option) => (
              <Chip
                key={option.id}
                testId={`demo-world-${row.key}-${option.id}`}
                active={WORLD[row.key] === option.id}
                onClick={() => switchWorld({ [row.key]: option.id } as Partial<AssistWorld>)}
              >
                {option.name}
              </Chip>
            ))}
          </div>
        ))}
        {CONNECTOR_PROVIDERS.map((provider) => (
          <div key={provider} className="mt-1.5 flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-[11px] text-muted-foreground">
              {CONNECTOR_LABEL[provider]}
            </span>
            {(["on", "off", "expired"] as const).map((state) => (
              <Chip
                key={state}
                testId={`demo-world-${provider}-${state}`}
                active={WORLD.connectors[provider] === state}
                onClick={() =>
                  switchWorld({ connectors: { ...WORLD.connectors, [provider]: state } })
                }
              >
                {STATE_LABEL[state]}
              </Chip>
            ))}
          </div>
        ))}
        <div className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Компьютеры
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Chip
            testId="demo-mc-drop-mac"
            active={false}
            onClick={() => {
              setOpen(false);
              dropLink("mac", 10);
            }}
          >
            Уронить связь с MacBook на 10 с
          </Chip>
          <Chip
            testId="demo-mc-wake-free"
            active={false}
            onClick={() => {
              setOpen(false);
              wakeComputer("product");
            }}
          >
            Разбудить free-cloud
          </Chip>
        </div>
        <div className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Сцены
        </div>
        <ol className="mt-1">
          {listScenes().map((scene) => (
            <li key={scene.id} className="flex items-start gap-2 rounded-lg py-1.5">
              <div className="min-w-0 flex-1">
                <div className="text-[13px] leading-tight font-medium">{scene.title}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {scene.hint}
                </div>
              </div>
              <button
                type="button"
                data-testid={`demo-scene-${scene.id}`}
                onClick={() => {
                  setOpen(false);
                  void runScene(router, scene.id);
                }}
                className="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90"
              >
                Показать
              </button>
            </li>
          ))}
        </ol>
        <div className="mt-2 text-[11px] leading-snug text-muted-foreground">
          В чате с Uno можно писать и самому: «morning summary», «send the Acme reminder», «export
          the deck on my Mac», «connect my apps», «connect Telegram», «break something».
        </div>
      </div>
    </div>
  );
}
