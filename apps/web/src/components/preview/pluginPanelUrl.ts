/**
 * Подписанный URL iframe панели плагина.
 *
 * Панель живёт в sandbox-iframe без `allow-same-origin` и сессионную куку не
 * несёт, поэтому демон отдаёт её файлы только по токену в пути
 * (`/api/plugins/<id>/panel/<token>/…`, см. `apps/server/src/plugins/panelTokens.ts`).
 * Токен выдаёт аутентифицированный RPC `plugins.issuePanelUrl`; документ панели
 * должен загрузиться в течение пары минут после выдачи, поэтому URL
 * запрашивается при каждом монтировании вкладки и в состоянии вкладки не
 * хранится.
 */
import { useEffect, useState } from "react";

import { getPrimaryEnvironmentConnection } from "../../environments/runtime";

export type PluginPanelUrlState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "error"; readonly message: string };

export function usePluginPanelSignedUrl(pluginId: string | null): PluginPanelUrlState {
  const [state, setState] = useState<PluginPanelUrlState>({ status: "loading" });

  useEffect(() => {
    if (!pluginId) {
      setState({ status: "error", message: "Panel has no plugin id" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    getPrimaryEnvironmentConnection()
      .client.server.issuePluginPanelUrl({ pluginId })
      .then(
        (result) => {
          if (!cancelled) setState({ status: "ready", url: result.url });
        },
        (error: unknown) => {
          if (cancelled) return;
          setState({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [pluginId]);

  return state;
}
