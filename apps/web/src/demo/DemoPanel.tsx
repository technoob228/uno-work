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

// Pult 4: this build shows only the Pult points (the Work mock has its own site).
const POINTS: ReadonlyArray<{
  key: DemoShowKey;
  title: string;
  hint: string;
  switches?: ReadonlyArray<keyof DemoSwitches>;
}> = [
  {
    key: "q1",
    title: "Пульт за 5 секунд",
    hint: "Одна строка «где ты нужен», вопросы с кнопками ответа, задачи списком: точка, прогресс, где.",
    switches: ["pult"],
  },
  {
    key: "q2",
    title: "Ответить одним нажатием",
    hint: "Кнопка в Пульте — и ответ уходит сообщением в настоящий чат задачи, агент отвечает.",
  },
  {
    key: "q3",
    title: "Задача: что нужно, где смотреть, прод",
    hint: "Клик по задаче — её чат в центре, справа: от тебя, ссылка+пароль, прод/стейдж, что осталось. Остальное — «Подробнее».",
  },
  {
    key: "q4",
    title: "Диспетчер: «нужна ли помощь Спаркам?»",
    hint: "Одно поле наверху Пульта отвечает по всем чатам. ⇧⌘K — фокус.",
  },
  {
    key: "q5",
    title: "Скрин + строка → в нужный чат",
    hint: "Вставь скрин (⌘V) и напиши правку — диспетчер найдёт чат задачи и передаст.",
  },
  {
    key: "q6",
    title: "Выкатки, просьбы, лимиты, алерты, решения",
    hint: "Отдельные экраны в меню «Задачи ▾» — сверху Пульта, не на главном экране.",
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
        className="fixed bottom-2.5 left-2.5 z-[90] inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-popover px-3 text-xs font-medium text-popover-foreground shadow-lg hover:bg-accent"
      >
        <EyeIcon className="size-3.5" />
        Что смотреть · Пульт
        <ChevronUpIcon className="size-3.5 text-muted-foreground" />
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Что смотреть"
      data-testid="demo-panel"
      className="fixed bottom-2.5 left-2.5 z-[90] flex max-h-[calc(100vh-1.25rem)] w-[min(25rem,calc(100vw-1.5rem))] flex-col rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Что смотреть</div>
          <div className="text-[11px] text-muted-foreground">
            Пульт 4 внутри мока Uno Work · данные выдуманные, ничего не уходит наружу
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
