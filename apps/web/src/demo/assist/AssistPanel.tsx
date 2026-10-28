/**
 * The assistants base (28.10): the floating "what to look at" card — the
 * account's state (switches reload the demo in that world) and the scenes
 * (things that happen without the person typing). Only in `VITE_DEMO=assist`.
 * Playwright drives the same through `window.__assistDemo` (e2e/README).
 */
import { ASSISTANT_PROJECT_ID } from "@t3tools/contracts";
import { ChevronDownIcon, EyeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { getRouter } from "../../router";
import { useActiveFollowsOpenChat } from "../DemoPanel";
import { assistDemo } from "../demoBoot";
import type { MachineKey } from "../heavyFixtures";
import { listScenes, play } from "./engine";
import { waitForThread } from "../../components/assistants/useUnoHome";
import { personaOf } from "./daemon";
import { VARIANT } from "./variant";
import {
  type AssistWorld,
  CONNECTOR_PROVIDERS,
  type ConnectorProvider,
  type ConnectorState,
  WORLD,
  switchWorld,
  worldStamp,
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
    key: "third",
    label: "3-й комп.",
    options: [
      { id: "asleep", name: "Спит" },
      { id: "online", name: "Онлайн" },
    ],
  },
  {
    key: "many",
    label: "Много",
    options: [
      { id: "off", name: "Обычно" },
      { id: "on", name: "12 каналов, 10 своих" },
    ],
  },
  {
    key: "face",
    label: "Лица",
    options: [
      { id: "ok", name: "Рисуются" },
      { id: "fail", name: "Ошибка" },
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
  const machine = target?.machine ?? "work";
  const projectId = target?.projectId ?? ASSISTANT_PROJECT_ID;
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
  useActiveFollowsOpenChat(router);
  const [open, setOpen] = useState(() =>
    typeof window === "undefined"
      ? true
      : window.innerWidth >= 900 && !/[?&]panel=closed/.test(location.search),
  );
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The page asks its computers again when the demo changed something behind it.
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__assistRefresh = () =>
      void router.options.context.queryClient.invalidateQueries();
  }, [router]);
  // Variant A: a new account opens on Uno — it's already there and talks first (Duet).
  // Free: uno-work slept overnight — Uno catches up the moment Work opens.
  useEffect(() => {
    const once = (name: string) => {
      const key = `${name}:${worldStamp(WORLD)}`;
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, "1");
      return true;
    };
    const timer = setTimeout(() => {
      if (WORLD.account === "new" && once("demo:a-first-open")) {
        if (["", "#/", "#/computer"].includes(location.hash)) {
          const threadId = assistDemo.mainChat("work", ASSISTANT_PROJECT_ID);
          const environmentId = assistDemo.environmentOf("work");
          void waitForThread(environmentId, threadId).then(() =>
            router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId },
            } as never),
          );
        }
      }
      if (WORLD.account === "live" && WORLD.tier === "free" && once("demo:a-free-wake")) {
        const scene = listScenes().find((item) => item.id === "free-wake");
        const persona = personaOf("work", ASSISTANT_PROJECT_ID);
        if (scene && persona) {
          const threadId = assistDemo.mainChat("work", ASSISTANT_PROJECT_ID);
          scene.run({
            ops: assistDemo.ops,
            world: WORLD,
            target: { machine: "work", threadId, persona },
            play: (script) => play("work", threadId, script),
          });
        }
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [router]);
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__assistDemo = {
      world: WORLD,
      scenes: () => listScenes().map((scene) => scene.id),
      scene: (id: string, target?: { machine?: MachineKey; projectId?: string }) =>
        runScene(router, id, target),
      mainChat: (machine?: MachineKey, projectId?: string) =>
        assistDemo.mainChat(machine, projectId),
      environmentOf: assistDemo.environmentOf,
      switchWorld,
    };
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
          <div className="text-sm font-semibold">Ассистенты · {VARIANT.title}</div>
          <div className="text-[11px] text-muted-foreground">
            Настоящий Uno Work · данные выдуманные, ничего не уходит наружу
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
          Вариант A: один Uno на аккаунт, живёт на uno-work (Plus не спит), остальные компьютеры —
          его руки. Темы — каналы (Everything, «New channel»). Свои ассистенты — на странице Uno →
          Advanced (галерея как в Grok). Писать Uno можно самому: «morning summary», «send the Acme
          reminder», «export the deck on my Mac», «build the landing», «go through the launch
          checklist», «what computers do you see», «outline the newsletter», «break something».
        </div>
      </div>
    </div>
  );
}
