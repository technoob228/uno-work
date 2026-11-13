/**
 * "Move my projects here" (13.11): the demo's "what to look at" card for this
 * path — `?tour=dev` puts it in place of the computers card. How to walk it
 * from Uno's first question, and the screens to open directly.
 */
import { ChevronDownIcon, EyeIcon } from "lucide-react";
import type { ReactNode, RefObject } from "react";

import type { getRouter } from "../../router";

type DemoRouter = ReturnType<typeof getRouter>;

/** `?tour=dev`: this demo is the developer way's. */
export const DEV_TOUR =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("tour") === "dev";

function Chip(props: { onClick: () => void; children: ReactNode; testId: string }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-testid={props.testId}
      className="cursor-pointer rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {props.children}
    </button>
  );
}

/** Everything the demo kept (chats, setup, the MacBook): gone; the address' world stays. */
function startOver() {
  localStorage.clear();
  sessionStorage.clear();
  location.replace(`${location.pathname}${location.search}`);
}

export function DevOnboardingPanel(props: {
  router: DemoRouter;
  open: boolean;
  setOpen: (open: boolean) => void;
  panelRef: RefObject<HTMLDivElement | null>;
  openUno: () => void;
}) {
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
  const go = (to: string, search?: Record<string, string>) => {
    props.setOpen(false);
    void props.router.navigate({ to, ...(search ? { search } : {}) } as never);
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
          <div className="text-sm font-semibold">Move my projects here</div>
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
        <div className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Как пройти
        </div>
        <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[12px] leading-snug">
          <li>
            Чат Uno: «What do you mostly do?» → <b>I build software</b> (или своими словами: «I'm a
            developer», «I code»).
          </li>
          <li>
            Две кнопки: <b>Sign in to Claude Code / Codex</b> или{" "}
            <b>Import projects from my computer</b>.
          </li>
          <li>
            Sign in: Claude Code → Sign in → Sign in with your account (демо входит само за пару
            секунд) → Continue with Claude Code.
          </li>
          <li>
            Import: Download Uno Work — MacBook подключится сам через ~3 с → A full computer →
            отметь проекты и ключи → Bring.
          </li>
          <li>
            First chat: каждый проект копируется ~5 с, ios-app не влезает (2,4 ГБ) → Start a chat.
          </li>
        </ol>
        <div className="mt-3 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Открыть
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <Chip
            testId="dev-open-uno"
            onClick={() => {
              props.setOpen(false);
              props.openUno();
            }}
          >
            Чат Uno
          </Chip>
          <Chip testId="dev-open-home" onClick={() => go("/")}>
            Home: строка «Move my projects here»
          </Chip>
          <Chip testId="dev-open-start" onClick={() => go("/setup", { step: "start" })}>
            Три пути
          </Chip>
          <Chip testId="dev-open-project" onClick={() => go("/setup", { step: "project" })}>
            Путь с AI: шаг Project
          </Chip>
          <Chip testId="dev-start-over" onClick={startOver}>
            Начать заново
          </Chip>
        </div>
      </div>
    </div>
  );
}
