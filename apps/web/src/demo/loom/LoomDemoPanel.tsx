/**
 * Loom Work demo: the "what to look at" card — how to try it, the scenario
 * switch for the edge cases, and a button that opens the chat to try it in.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon, EyeIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { getRouter } from "../../router";
import { useStore } from "../../store";
import { demoResetChatIn } from "../demoBoot";
import { demoHooks } from "../demoFlag";
import { ENV_PRODUCT } from "../heavyFixtures";
import { LOOM_SCENARIOS, type LoomScenario, loomScenario, setLoomScenario } from "./loomDemo";

type DemoRouter = ReturnType<typeof getRouter>;

export const LOOM_CHAT = "s-pricing";

export async function openLoomChat(router: DemoRouter) {
  useStore.getState().setActiveEnvironmentId(ENV_PRODUCT as EnvironmentId);
  demoResetChatIn(ENV_PRODUCT, LOOM_CHAT);
  await router.navigate({
    to: "/$environmentId/$threadId",
    params: { environmentId: ENV_PRODUCT, threadId: LOOM_CHAT },
  });
}

export default function LoomDemoPanel({ router }: { router: DemoRouter }) {
  demoHooks.router = router;
  const [open, setOpen] = useState(
    () => new URLSearchParams(location.search).get("panel") !== "closed",
  );
  const [scenario, setScenario] = useState<LoomScenario>(loomScenario);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="loom-panel-pill"
        className="fixed top-3 right-3 z-[90] inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-popover px-3 py-1.5 text-[11px] font-medium text-popover-foreground shadow-lg hover:bg-accent"
      >
        <EyeIcon className="size-3.5" />
        Что смотреть · Loom Work
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-label="Что смотреть"
      data-testid="loom-panel"
      className="fixed top-3 right-3 z-[90] flex w-[min(23rem,calc(100vw-1.5rem))] flex-col gap-2 rounded-2xl border border-border bg-popover p-3.5 text-popover-foreground shadow-xl"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Loom Work — показать агенту</div>
          <div className="text-[11px] leading-snug text-muted-foreground">
            Прототип 28.10 · настоящий Uno Work на демо-данных. Запись настоящая (экран, камера,
            голос, всё остаётся в браузере). Uno Drive и «просмотр» агентом здесь изображены —
            расшифровка заготовлена.
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
      <ol className="list-decimal space-y-0.5 pl-5 text-[12px] leading-snug">
        <li>Открой чат (кнопка ниже) — или любой другой.</li>
        <li>
          В поле ввода — кнопка с камерой рядом с микрофоном: что записывать, камера, микрофон →
          Start.
        </li>
        <li>Браузер спросит, что показать. Говори и показывай; внизу — время, пауза, Done.</li>
        <li>
          После Done: карточка в поле — видео уходит в Uno Drive/Recordings, агент «смотрит», твои
          слова встают в поле.
        </li>
        <li>Допиши, отправь — в чате плеер, ссылка, «что агент увидел», и ответ агента.</li>
      </ol>
      <button
        type="button"
        data-testid="loom-open-chat"
        onClick={() => void openLoomChat(router)}
        className="cursor-pointer rounded-md bg-primary px-2 py-1.5 text-[12px] font-medium text-primary-foreground hover:bg-primary/90"
      >
        Открыть чат «pricing» на uno-product
      </button>
      <div className="mt-1 text-[12px] font-medium">Сценарий (крайние случаи)</div>
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="Сценарий">
        {LOOM_SCENARIOS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={scenario === item.id}
            data-testid={`loom-scenario-${item.id}`}
            onClick={() => {
              setLoomScenario(item.id);
              setScenario(item.id);
            }}
            className={cn(
              "flex cursor-pointer flex-col rounded-md border px-2 py-1 text-left",
              scenario === item.id
                ? "border-foreground/70 bg-foreground/5"
                : "border-border hover:bg-accent",
            )}
          >
            <span className="text-[12px] font-medium">{item.name}</span>
            <span className="text-[11px] text-muted-foreground">{item.hint}</span>
          </button>
        ))}
      </div>
      {location.hostname.endsWith(".uno4.me") ? (
        <div
          className="rounded-md border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-200"
          data-testid="loom-hosting-note"
        >
          Здесь, на Uno Sites, хостинг запрещает сайтам камеру и микрофон (заголовок
          Permissions-Policy) — экран и звук вкладки пишутся, камера и голос нет. В настоящем Work
          (десктоп и облачный компьютер) запрета нет.
        </div>
      ) : null}
      <div className="text-[11px] leading-snug text-muted-foreground">
        Ещё крайние случаи — закрыть окно выбора (ничего не происходит), «Stop sharing» в браузере
        (= Done), запрет камеры/микрофона (пишет без них и говорит об этом), 60 минут
        (останавливается сама; записи длиннее 5 минут агент смотрит по частям через Uno Drive).
      </div>
    </div>
  );
}
