/**
 * Demo mode (w0138 mock): the floating "what to look at" card — 8 points,
 * each with "Показать" that puts the interface into the state to look at,
 * and the switches where two ways are compared. Folds into a pill as soon as
 * the person works with the app. Only in the demo (main.tsx loads it).
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, EyeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import type { getRouter } from "../router";
import { useStore } from "../store";
import {
  DEMO_SWITCH_OPTIONS,
  demoHooks,
  demoShow,
  useDemoStore,
  type DemoShowKey,
  type DemoSwitches,
} from "./demoFlag";
import { machineByEnv } from "./heavyFixtures";
import "./show";

type DemoRouter = ReturnType<typeof getRouter>;

/** A chat opened from the joined list makes its computer the active one. */
function useActiveFollowsOpenChat(router: DemoRouter) {
  useEffect(() => {
    const sync = () => {
      const environmentId = router.state.location.pathname.split("/")[1] ?? "";
      if (!machineByEnv(environmentId)) return;
      if (useStore.getState().activeEnvironmentId !== environmentId) {
        useStore.getState().setActiveEnvironmentId(environmentId as EnvironmentId);
      }
    };
    sync();
    return router.subscribe("onResolved", sync);
  }, [router]);
}

const POINTS: ReadonlyArray<{
  key: DemoShowKey;
  title: string;
  hint: string;
  switches?: ReadonlyArray<keyof DemoSwitches>;
}> = [
  {
    key: "p1",
    title: "Лаунчер панели",
    hint: "Две разные кнопки: «Your site» (всегда первая) и «Agent's browser»; без Terminal, Apps всегда.",
  },
  {
    key: "p2",
    title: "Комментарии и отладка в браузере",
    hint: "Одна кнопка Comment (C): заметки к элементам и областям + консоль и сеть внизу, «Ask agent to fix».",
  },
  {
    key: "p2b",
    title: "Браузер агента: войти за агента",
    hint: "Агент просит войти (логин, капча, 2FA) — Take control, вошёл, Hand back; дальше агент работает с этой сессией.",
  },
  {
    key: "p3",
    title: "Вкладка на весь экран",
    hint: "Плотный блок «шаг + композер», сворачивание в мини-окно, ответ подсказкой.",
    switches: ["chatDock"],
  },
  {
    key: "p4",
    title: "Вкладки: чат, проект, везде",
    hint: "Группы с обводкой: Everywhere → Project → This chat. Перетащи вкладку в другую группу или правый клик «Move to». Перейди в другой чат landing — Everywhere и Project на месте. «All tabs» — вкладки других чатов.",
    switches: ["tabGroupIcons", "newTabsGo"],
  },
  {
    key: "p5",
    title: "Верх сайдбара",
    hint: "Один заголовок говорит, что показано; ✎ New chat крайний справа; компьютеры.",
    switches: ["sidebarViewSwitch"],
  },
  {
    key: "p5b",
    title: "Сайдбар: фильтр и группировка",
    hint: "Всё в меню заголовка: Group by, проекты и компьютеры чипами; активный фильтр — чип с ×.",
  },
  {
    key: "p6",
    title: "Чаты ассистента в сайдбаре",
    hint: "Шеврон у ассистента раскрывает его чаты, «+» — новый чат с ним.",
  },
  {
    key: "p7",
    title: "Ассистенты: команда и онбординг",
    hint: "Uno, Builder, Scout; «+ New assistant» — 6 шагов; страница ассистента.",
  },
  {
    key: "p8",
    title: "↗ у файла: редактор или ссылка",
    hint: "На Mac — меню «Open in…» / «Share with a link…», на облаке — сразу Share.",
    switches: ["platform"],
  },
  {
    key: "p9",
    title: "Продвинутые настройки тиммейта",
    hint: "Settings → Connectors (прямой адрес #/settings/connectors); у тиммейта — коннекторы с уровнями, браузер и логины, ключи, скиллы.",
    switches: ["connectors"],
  },
];

function SwitchRow({ name }: { name: keyof DemoSwitches }) {
  const value = useDemoStore((state) => state.switches[name]);
  const setSwitch = useDemoStore((state) => state.setSwitch);
  const spec = DEMO_SWITCH_OPTIONS[name];
  return (
    <div className="mt-1.5 flex items-center gap-1.5 pl-6" role="radiogroup" aria-label={spec.label}>
      {spec.options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          onClick={() => setSwitch(name, option.id as never)}
          data-testid={`demo-switch-${name}-${option.id}`}
          className={cn(
            "cursor-pointer rounded-md border px-2 py-0.5 text-[11px] transition-colors",
            value === option.id
              ? "border-foreground/70 bg-foreground/5 text-foreground"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {option.name}
        </button>
      ))}
    </div>
  );
}

export default function DemoPanel({ router }: { router: DemoRouter }) {
  useActiveFollowsOpenChat(router);
  demoHooks.router = router;
  const [open, setOpen] = useState(() =>
    typeof window === "undefined" ? true : window.innerWidth >= 900,
  );
  const [busy, setBusy] = useState<DemoShowKey | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
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

  const show = async (key: DemoShowKey) => {
    const fn = demoShow[key];
    if (!fn) return;
    setBusy(key);
    setOpen(false);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="demo-panel-pill"
        title="Что смотреть — 10 пунктов мока"
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
      className="fixed top-1/2 left-[16.75rem] z-[90] flex max-h-[calc(100vh-1.25rem)] -translate-y-1/2 w-[min(25rem,calc(100vw-1.5rem))] flex-col rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Что смотреть</div>
          <div className="text-[11px] text-muted-foreground">
            Мок Uno Work 0.0.138 · данные выдуманные, ничего не уходит наружу
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
      <ol className="min-h-0 overflow-y-auto px-2 pb-2">
        {POINTS.map((point) => (
          <li key={point.key} className="rounded-lg px-1.5 py-1.5 hover:bg-accent/40">
            <div className="flex items-start gap-2">
              <span className="mt-px w-4 shrink-0 text-right text-xs font-semibold text-muted-foreground tabular-nums">
                {point.key.slice(1)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] leading-tight font-medium">{point.title}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {point.hint}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void show(point.key)}
                disabled={!demoShow[point.key] || busy !== null}
                data-testid={`demo-show-${point.key}`}
                className="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-default disabled:opacity-40"
              >
                Показать
              </button>
            </div>
            {point.switches?.map((name) => <SwitchRow key={name} name={name} />)}
          </li>
        ))}
      </ol>
    </div>
  );
}
