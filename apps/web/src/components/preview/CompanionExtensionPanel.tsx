/**
 * Веб-режим встроенного браузера. Electron-webview здесь нет, поэтому браузером
 * управляет расширение Uno Work Companion во вкладках пользователя. Панель
 * детектит расширение, ведёт по установке и открывает адреса через него.
 */
import {
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  Loader2Icon,
  PuzzleIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import {
  detectBrowserExtension,
  readDetectedExtensionVersion,
  readExtensionStatus,
  runExtensionBrowserCommand,
} from "../../browserExtensionBridge";
import { toastManager, stackedThreadToast } from "../ui/toast";
import { Button } from "../ui/button";

export const COMPANION_EXTENSION_DOWNLOAD_URL =
  "https://console.uno4.dev/cli/work/uno-work-companion-0.2.0.zip";

type DetectState = "checking" | "connected" | "missing";

export function CompanionExtensionPanel({
  url,
  onOpenExternal,
}: {
  url: string;
  onOpenExternal: () => void;
}) {
  const [detectState, setDetectState] = useState<DetectState>("checking");
  const [version, setVersion] = useState<string | null>(null);
  const [sharedTabs, setSharedTabs] = useState<number | null>(null);

  const check = useCallback(async () => {
    setDetectState("checking");
    const detected = await detectBrowserExtension();
    if (detected === null) {
      setDetectState("missing");
      return;
    }
    setVersion(readDetectedExtensionVersion());
    setDetectState("connected");
    const status = await readExtensionStatus();
    setSharedTabs(status?.sharedTabs ?? null);
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const openViaExtension = useCallback(async () => {
    try {
      await runExtensionBrowserCommand({ command: "openUrl", url });
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Открыто во вкладке браузера",
          description: "Агент получил доступ к этой вкладке.",
        }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Расширение не открыло вкладку",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }, [url]);

  if (detectState === "checking") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-muted-foreground">
        <Loader2Icon className="size-6 animate-spin opacity-60" />
        <p className="text-xs">Ищем расширение Uno Work Companion…</p>
      </div>
    );
  }

  if (detectState === "connected") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-muted-foreground">
        <CheckCircle2Icon className="size-8 text-emerald-500" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">
            Расширение подключено{version ? ` (v${version})` : ""}
          </p>
          <p className="mx-auto max-w-sm text-xs">
            Агент открывает страницы во вкладках этого браузера — в ваших живых сессиях. Он видит
            только вкладки, которые открыл сам{sharedTabs !== null ? ` (сейчас: ${sharedTabs})` : ""}
            , или те, что вы расшарили через значок расширения.
          </p>
        </div>
        {url ? (
          <Button size="sm" variant="outline" onClick={() => void openViaExtension()}>
            <ExternalLinkIcon className="size-3.5" />
            Открыть {new URL(url).hostname} во вкладке
          </Button>
        ) : (
          <p className="text-xs">Введите адрес в строке выше — он откроется новой вкладкой.</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 overflow-auto px-6 py-6 text-muted-foreground">
      <PuzzleIcon className="size-8 opacity-40" />
      <div className="space-y-1 text-center">
        <p className="text-sm font-medium text-foreground">
          Подключите расширение Uno Work Companion
        </p>
        <p className="mx-auto max-w-sm text-xs">
          В браузерной версии агент работает с вебом через расширение — в ваших вкладках и сессиях,
          без пароля и без удалённого браузера.
        </p>
      </div>
      <ol className="max-w-sm list-decimal space-y-1 pl-5 text-left text-xs">
        <li>Скачайте архив и распакуйте его в папку.</li>
        <li>
          Откройте <span className="font-mono">chrome://extensions</span> и включите «Режим
          разработчика».
        </li>
        <li>Нажмите «Загрузить распакованное расширение» и укажите папку из архива.</li>
        <li>Вернитесь сюда и обновите страницу.</li>
      </ol>
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          size="sm"
          render={<a href={COMPANION_EXTENSION_DOWNLOAD_URL} download />}
        >
          <DownloadIcon className="size-3.5" />
          Скачать расширение
        </Button>
        <Button size="sm" variant="outline" onClick={() => void check()}>
          <RefreshCwIcon className="size-3.5" />
          Проверить снова
        </Button>
        {url ? (
          <Button size="sm" variant="ghost" onClick={onOpenExternal}>
            <ExternalLinkIcon className="size-3.5" />
            Открыть в новой вкладке
          </Button>
        ) : null}
      </div>
    </div>
  );
}
