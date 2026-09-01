import type { PluginsSnapshot, ServerPlugin } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, Loader2Icon, PuzzleIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../../environments/runtime";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { makePluginPanelFile, usePreviewPane } from "../preview/PreviewPaneContext";
import { toastManager } from "../ui/toast";
import { FeatureDisabledPanel } from "./FeatureDisabledPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ExtensionsSettingsPanel() {
  const pluginsEnabled = useFeatureFlag("plugins");
  const [snapshot, setSnapshot] = useState<PluginsSnapshot | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const { openFile } = usePreviewPane();
  const navigate = useNavigate();

  // Правая панель в настройках скрыта, поэтому после открытия вкладки уводим
  // пользователя обратно в чат — иначе «Открыть панель» выглядит как no-op.
  const handleOpenPanel = useCallback(
    (plugin: ServerPlugin) => {
      if (!plugin.panel) return;
      openFile(makePluginPanelFile(plugin.id, plugin.panel.title));
      void navigate({ to: "/" });
    },
    [navigate, openFile],
  );

  useEffect(() => {
    return getPrimaryEnvironmentConnection().client.server.subscribePlugins((next) => {
      setSnapshot(next);
    });
  }, []);

  const handleToggle = useCallback(async (plugin: ServerPlugin) => {
    setTogglingId(plugin.id);
    try {
      const next = await getPrimaryEnvironmentConnection().client.server.setPluginEnabled({
        pluginId: plugin.id,
        enabled: !plugin.enabled,
      });
      setSnapshot(next);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Не удалось переключить плагин",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTogglingId(null);
    }
  }, []);

  const plugins = snapshot?.plugins ?? [];

  if (!pluginsEnabled) {
    return <FeatureDisabledPanel feature="Plugins" />;
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Плагины" icon={<PuzzleIcon className="size-3.5" />}>
        {snapshot === null ? (
          <SettingsRow
            title={<Loader2Icon className="size-4 animate-spin text-muted-foreground" />}
            description="Загрузка…"
          />
        ) : plugins.length === 0 ? (
          <SettingsRow
            title="Пока пусто"
            description="Попросите агента в чате расширить приложение — например: «сделай, чтобы каждый вечер в 19:00 мне собирался дайджест коммитов». Агент создаст плагин, и он появится здесь."
          />
        ) : (
          plugins.map((plugin) => (
            <PluginRow
              key={plugin.id}
              plugin={plugin}
              toggling={togglingId === plugin.id}
              onToggle={() => void handleToggle(plugin)}
              onOpenPanel={() => handleOpenPanel(plugin)}
            />
          ))
        )}
      </SettingsSection>

      {snapshot !== null ? (
        <p className="px-1 text-xs text-muted-foreground">
          Плагин — это{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">&lt;id&gt;.json</code> или
          директория{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">&lt;id&gt;/plugin.json</code> в{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{snapshot.pluginsDir}</code>.
          Демон подхватывает изменения без рестарта; hooks реагируют на события приложения, crons
          выполняются по расписанию, а панель плагина открывается вкладкой в правой панели.
        </p>
      ) : null}
    </SettingsPageContainer>
  );
}

function PluginRow({
  plugin,
  toggling,
  onToggle,
  onOpenPanel,
}: {
  plugin: ServerPlugin;
  toggling: boolean;
  onToggle: () => void;
  onOpenPanel: () => void;
}) {
  const summaryParts = [
    ...(plugin.panel ? [`панель: ${plugin.panel.title}`] : []),
    ...(plugin.hooks.length > 0
      ? [`hooks: ${plugin.hooks.map((hook) => hook.on).join(", ")}`]
      : []),
    ...(plugin.crons.length > 0
      ? [`crons: ${plugin.crons.map((cron) => cron.label).join(", ")}`]
      : []),
  ];
  const lastRun = plugin.recentRuns[0];

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {plugin.name}
          {plugin.version ? (
            <span className="text-[11px] text-muted-foreground">v{plugin.version}</span>
          ) : null}
          {!plugin.valid ? <AlertTriangleIcon className="size-3.5 text-destructive" /> : null}
        </span>
      }
      description={
        <span className="space-y-0.5">
          {plugin.description ? <span className="block">{plugin.description}</span> : null}
          {!plugin.valid && plugin.error ? (
            <span className="block text-destructive">{plugin.error}</span>
          ) : null}
          {summaryParts.length > 0 ? (
            <span className="block font-mono text-[11px]">{summaryParts.join(" · ")}</span>
          ) : null}
          {lastRun ? (
            <span className="block text-[11px]">
              Последний запуск: {lastRun.ok ? "ok" : "ошибка"} ·{" "}
              {new Date(lastRun.at).toLocaleString()} · {lastRun.trigger}
              {!lastRun.ok && lastRun.detail ? ` — ${lastRun.detail}` : ""}
            </span>
          ) : null}
        </span>
      }
      control={
        plugin.valid ? (
          <span className="flex items-center gap-2">
            {plugin.panel && plugin.enabled ? (
              <button
                type="button"
                onClick={onOpenPanel}
                className="rounded-md border border-input px-3 py-1.5 text-xs text-foreground hover:bg-accent"
              >
                Открыть панель
              </button>
            ) : null}
            <button
              type="button"
              disabled={toggling}
              onClick={onToggle}
              className="inline-flex overflow-hidden rounded-md border border-input text-xs"
              aria-label={plugin.enabled ? "Выключить плагин" : "Включить плагин"}
            >
              <span
                className={
                  plugin.enabled
                    ? "bg-accent px-3 py-1.5 text-accent-foreground"
                    : "px-3 py-1.5 text-muted-foreground"
                }
              >
                Вкл
              </span>
              <span
                className={
                  plugin.enabled
                    ? "px-3 py-1.5 text-muted-foreground"
                    : "bg-accent px-3 py-1.5 text-accent-foreground"
                }
              >
                Выкл
              </span>
            </button>
          </span>
        ) : null
      }
    />
  );
}
