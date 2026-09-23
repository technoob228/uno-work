/**
 * Personal AI — модель на личном GPU аккаунта.
 *
 * Выбрал такую модель → над полем ввода появляется карточка: цена за час,
 * кнопка Start, потом «GPU стартует, осталось ~N мин» с шагами. Сообщение,
 * отправленное до готовности, не уходит в харнесс: оно ждёт в поле ввода и
 * отправляется само, когда модель готова (см. ChatComposer.submitComposer).
 * Статус живёт на бэкенде (gpu.uno4.dev/personal/models), здесь — опрос.
 */

import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CircleIcon, CpuIcon, LoaderCircleIcon } from "lucide-react";
import type { ModelCapabilities, PersonalAiModel } from "@t3tools/contracts";

import { readLocalApi } from "../../localApi";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const PERSONAL_SLUG_PREFIX = "uno-personal/";
/** Пока стартует — опрашиваем часто: человек смотрит на таймер. */
const POLL_STARTING_MS = 5_000;
/** Готова/выключена — редко: заметить, что GPU ушёл после простоя. */
const POLL_IDLE_MS = 45_000;

export function isPersonalAiModel(capabilities: ModelCapabilities | undefined): boolean {
  return capabilities?.metadata?.personal !== undefined;
}

export function personalAiModelId(slug: string): string {
  return slug.startsWith(PERSONAL_SLUG_PREFIX) ? slug.slice(PERSONAL_SLUG_PREFIX.length) : slug;
}

/** Можно ли слать сообщение прямо сейчас: спящая модель просыпается за ~1 с. */
export function personalAiCanSend(model: PersonalAiModel | null): boolean {
  if (model === null) return true; // статуса ещё нет — не мешаем, шлюз прогреет сам
  return model.state === "ready" || model.state === "sleeping";
}

export function formatHourlyPrice(usd: number): string {
  return `$${usd.toFixed(usd >= 10 ? 0 : 2)}/hour`;
}

export function formatEta(seconds: number): string {
  // Оценка бэкенда снизу упирается в 10 с, а последний шаг (старт vLLM) бывает
  // дольше плана — честнее «почти», чем «меньше минуты» три минуты подряд.
  if (seconds <= 45) return "almost ready";
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}

function formatIdle(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)} s`;
  return `${Math.round(seconds / 60)} min`;
}

export interface PersonalAiHandle {
  readonly model: PersonalAiModel | null;
  readonly busy: boolean;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * Состояние выбранной Personal AI модели. modelId = null — выбрана обычная
 * модель, ничего не опрашиваем.
 */
export function usePersonalAi(modelId: string | null): PersonalAiHandle {
  const [model, setModel] = useState<PersonalAiModel | null>(null);
  const [busy, setBusy] = useState(false);
  const previousState = useRef<PersonalAiModel["state"] | null>(null);

  const refresh = useCallback(async () => {
    const api = readLocalApi();
    if (!api || modelId === null) return;
    try {
      const result = await api.server.listPersonalAi();
      setModel(result.models.find((candidate) => candidate.id === modelId) ?? null);
    } catch {
      // сеть моргнула — оставляем прошлый статус, следующий опрос поправит
    }
  }, [modelId]);

  useEffect(() => {
    setModel(null);
    previousState.current = null;
    if (modelId === null) return;
    void refresh();
  }, [modelId, refresh]);

  const state = model?.state ?? null;
  useEffect(() => {
    if (modelId === null) return;
    const interval = state === "starting" ? POLL_STARTING_MS : POLL_IDLE_MS;
    const timer = window.setInterval(() => void refresh(), interval);
    return () => window.clearInterval(timer);
  }, [modelId, refresh, state]);

  // Отмашка: модель поднялась, пока человек ждал.
  useEffect(() => {
    if (model === null) return;
    if (previousState.current === "starting" && personalAiCanSend(model)) {
      toastManager.add({
        type: "success",
        title: `${model.name} is ready`,
        description: "Your private GPU is up. Chat works as usual now.",
      });
    }
    if (previousState.current === "starting" && model.state === "failed") {
      toastManager.add({
        type: "error",
        title: `${model.name} could not start`,
        description: model.error || "Try again in a few minutes.",
      });
    }
    previousState.current = model.state;
  }, [model]);

  const act = useCallback(
    async (action: "start" | "stop") => {
      const api = readLocalApi();
      if (!api || modelId === null) return;
      setBusy(true);
      try {
        const next =
          action === "start"
            ? await api.server.startPersonalAi({ modelId })
            : await api.server.stopPersonalAi({ modelId });
        setModel(next);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: action === "start" ? "Could not start your GPU" : "Could not stop the model",
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(false);
      }
    },
    [modelId],
  );

  const start = useCallback(() => act("start"), [act]);
  const stop = useCallback(() => act("stop"), [act]);
  return { model, busy, start, stop };
}

/** Секунды до готовности, тикающие между опросами. */
function useCountdown(eta: number | null): number | null {
  const [anchor, setAnchor] = useState<{ at: number; eta: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const at = Date.now();
    setAnchor(eta === null ? null : { at, eta });
    setNow(at);
  }, [eta]);
  useEffect(() => {
    if (eta === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [eta]);
  if (anchor === null) return eta;
  return Math.max(10, anchor.eta - Math.round((now - anchor.at) / 1000));
}

export const PersonalAiPanel = memo(function PersonalAiPanel({
  handle,
  queued,
  onCancelQueued,
}: {
  handle: PersonalAiHandle;
  queued: boolean;
  onCancelQueued: () => void;
}) {
  const { model, busy, start, stop } = handle;
  const countdown = useCountdown(model?.state === "starting" ? (model.etaS ?? null) : null);
  if (model === null) return null;

  const price = formatHourlyPrice(model.priceUsdPerHour);
  const idle = formatIdle(model.idleSleepS);

  let title: string;
  let description: string;
  let action: ReactNode = null;
  switch (model.state) {
    case "off":
      title = `${model.name} runs on your private GPU`;
      description = `Starting takes about 5 minutes. ${price} while it works; it sleeps after ${idle} of quiet, and sleep is free.`;
      action = (
        <Button size="sm" type="button" onClick={() => void start()} disabled={busy}>
          {busy ? "Starting…" : "Start"}
        </Button>
      );
      break;
    case "starting":
      {
        const eta = formatEta(countdown ?? model.etaS ?? 300);
        title =
          eta === "almost ready"
            ? "Starting your private GPU — almost ready"
            : `Starting your private GPU — ${eta} left`;
      }
      description = queued
        ? "Your message is waiting and will be sent as soon as the model is ready."
        : "You can write your message now — it will be sent when the model is ready.";
      action = (
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => {
            onCancelQueued();
            void stop();
          }}
          disabled={busy}
        >
          Cancel
        </Button>
      );
      break;
    case "failed":
      title = `${model.name} could not start`;
      description = model.error || "Something went wrong on the GPU. Try again.";
      action = (
        <Button size="sm" type="button" onClick={() => void start()} disabled={busy}>
          Try again
        </Button>
      );
      break;
    default:
      title = `${model.name} · private GPU`;
      description =
        model.state === "sleeping"
          ? `Asleep — wakes in about a second when you send. ${price} while it works.`
          : `Ready. ${price} while it works; sleeps after ${idle} of quiet.`;
      action = (
        <Button size="sm" variant="ghost" type="button" onClick={() => void stop()} disabled={busy}>
          Stop
        </Button>
      );
  }

  return (
    <div
      className="rounded-t-[19px] border-b border-border/65 bg-muted/20 px-4 py-3 sm:px-5"
      data-personal-ai-state={model.state}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-muted-foreground/70">
          {model.state === "starting" ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <CpuIcon className="size-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground/90">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground/75">{description}</p>
          {model.state === "starting" && model.steps && model.steps.length > 0 ? (
            <ol className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/75">
              {model.steps.map((step) => (
                <li
                  key={step.id}
                  className={cn(
                    "flex items-center gap-1",
                    step.state === "active" && "text-foreground/85",
                    step.state === "pending" && "opacity-55",
                  )}
                >
                  {step.state === "done" ? (
                    <CheckIcon className="size-3" />
                  ) : step.state === "active" ? (
                    <LoaderCircleIcon className="size-3 animate-spin" />
                  ) : (
                    <CircleIcon className="size-3" />
                  )}
                  {step.label}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </div>
  );
});
