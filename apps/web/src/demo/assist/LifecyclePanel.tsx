/**
 * Computers lifecycle demo: the "what to look at" card for Misha — where the
 * demo starts (the MacBook not connected yet / already a full computer), how
 * the secondary path is shown (a/b/c), the browser or the desktop app, Dev
 * Mode, and putting the MacBook to sleep and waking it.
 */
import { ChevronDownIcon, EyeIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";
import {
  LC_START,
  LC_START_KEY,
  type FallbackVariant,
  type LcStart,
} from "../../computersLifecycle/flag";
import { lifecycle, useLifecycle } from "../../computersLifecycle/store";
import { setDevMode, useDevMode } from "../../devMode";
import type { getRouter } from "../../router";
import { useDemoStore } from "../demoFlag";
import { lcDemo } from "./lifecycle";
import { onLinksChanged } from "./links";
import { switchWorld } from "./world";

type DemoRouter = ReturnType<typeof getRouter>;

function Chip(props: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  testId: string;
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <span className="w-24 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function restart(start: LcStart) {
  localStorage.setItem(LC_START_KEY, start);
  location.replace(`${location.pathname}#/computer`);
}

const FALLBACKS: ReadonlyArray<{ id: FallbackVariant; name: string }> = [
  { id: "a", name: "а · меню компьютера" },
  { id: "b", name: "б · приложение на Mac" },
  { id: "c", name: "в · только Dev Mode" },
];

export function LifecyclePanel(props: {
  router: DemoRouter;
  open: boolean;
  setOpen: (open: boolean) => void;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  const fallback = useLifecycle((state) => state.fallback);
  const platform = useDemoStore((state) => state.switches.platform);
  const setSwitch = useDemoStore((state) => state.setSwitch);
  const devMode = useDevMode();
  const [asleep, setAsleep] = useState(lcDemo.asleep());
  useEffect(() => onLinksChanged(() => setAsleep(lcDemo.asleep())), []);

  if (!props.open) {
    return (
      <button
        type="button"
        onClick={() => props.setOpen(true)}
        data-testid="demo-panel-pill"
        className="fixed top-1/2 left-[16rem] z-[90] inline-flex translate-x-1 -translate-y-1/2 cursor-pointer flex-row items-center gap-1.5 rounded-full border border-border bg-popover px-1 py-2.5 text-[11px] font-medium text-popover-foreground shadow-lg [writing-mode:vertical-rl] hover:bg-accent"
      >
        <EyeIcon className="size-3.5" />
        Что смотреть
      </button>
    );
  }
  const go = (to: string) => {
    props.setOpen(false);
    void props.router.navigate({ to } as never);
  };
  return (
    <div
      ref={props.panelRef}
      role="dialog"
      aria-label="Что смотреть"
      data-testid="demo-panel"
      className="fixed top-1/2 left-[16.75rem] z-[90] flex max-h-[calc(100vh-1.25rem)] w-[min(26rem,calc(100vw-1.5rem))] -translate-y-1/2 flex-col rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl"
    >
      <div className="flex items-center gap-2 px-3.5 pt-3 pb-1">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Компьютеры: один путь</div>
          <div className="text-[11px] text-muted-foreground">
            Настоящий Uno Work · данные выдуманные, ничего не уходит наружу
          </div>
        </div>
        <button
          type="button"
          onClick={() => props.setOpen(false)}
          aria-label="Свернуть"
          className="ml-auto inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDownIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto px-3.5 pb-3">
        <Row label="Начало">
          <Chip
            testId="lc-start-fresh"
            active={LC_START === "fresh"}
            onClick={() => restart("fresh")}
          >
            MacBook не подключён
          </Chip>
          <Chip
            testId="lc-start-connected"
            active={LC_START === "connected"}
            onClick={() => restart("connected")}
          >
            уже полноценный
          </Chip>
        </Row>
        <Row label="Запасной путь">
          {FALLBACKS.map((option) => (
            <Chip
              key={option.id}
              testId={`lc-fallback-${option.id}`}
              active={fallback === option.id}
              onClick={() => lifecycle.setFallback(option.id)}
            >
              {option.name}
            </Chip>
          ))}
        </Row>
        <Row label="Work открыт">
          <Chip
            testId="lc-platform-cloud"
            active={platform === "cloud"}
            onClick={() => setSwitch("platform", "cloud")}
          >
            в браузере
          </Chip>
          <Chip
            testId="lc-platform-desktop"
            active={platform === "desktop"}
            onClick={() => setSwitch("platform", "desktop")}
          >
            приложение на Mac
          </Chip>
        </Row>
        <Row label="Dev Mode">
          <Chip testId="lc-dev-off" active={!devMode} onClick={() => setDevMode(false)}>
            выкл
          </Chip>
          <Chip testId="lc-dev-on" active={devMode} onClick={() => setDevMode(true)}>
            вкл
          </Chip>
        </Row>
        <Row label="MacBook">
          <Chip
            testId="lc-mac-sleep"
            active={asleep}
            onClick={() => {
              props.setOpen(false);
              lcDemo.sleep();
            }}
          >
            усыпить
          </Chip>
          <Chip
            testId="lc-mac-wake"
            active={!asleep}
            onClick={() => {
              props.setOpen(false);
              lcDemo.wake();
            }}
          >
            разбудить
          </Chip>
        </Row>
        <div className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Открыть
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Chip
            testId="lc-open-add"
            active={false}
            onClick={() => {
              props.setOpen(false);
              lifecycle.openAdd();
            }}
          >
            Add computer
          </Chip>
          <Chip
            testId="lc-open-desktop-path"
            active={false}
            onClick={() => {
              // Fresh MacBook, in the desktop app: the card «Make this Mac…» comes up on Home.
              localStorage.setItem(LC_START_KEY, "fresh");
              lifecycle.setThisMacPrompt("ask");
              switchWorld({ platform: "desktop" });
            }}
          >
            Приложение на Mac: «Make this Mac…»
          </Chip>
          <Chip testId="lc-open-home" active={false} onClick={() => go("/computer")}>
            Home
          </Chip>
          <Chip testId="lc-open-settings" active={false} onClick={() => go("/settings/computer")}>
            Settings → Computer
          </Chip>
        </div>
        <ol className="mt-3 list-decimal pl-4 text-[11px] leading-snug text-muted-foreground">
          <li>
            Home → «Connect your AI or other computers» → Add another computer → Your own computer →
            Download.
          </li>
          <li>«What is it for?» → A full computer → «Bring your work?» → Bring.</li>
          <li>
            Home: пикер «on» → MacBook, написать «run the tests», здесь «усыпить» → «Waiting for
            MacBook…», через 15 с «Continue in the cloud»; «разбудить» — ход продолжится.
          </li>
          <li>
            Чип компьютеров справа сверху → строка MacBook → Remove computer; uno-product → Delete
            computer.
          </li>
          <li>
            Запасной путь: а — в строке MacBook «Advanced»; б — «приложение на Mac» + Settings →
            This computer; в — то же, но только с Dev Mode.
          </li>
        </ol>
      </div>
    </div>
  );
}
