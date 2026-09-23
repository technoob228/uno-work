/**
 * The app label on an app task's AI calls (docs/app-sdk.md, "Tasks and the
 * app's limit").
 *
 * A task of an app is a Work chat run by a harness, and the harness talks to
 * the Uno AI gateway with the machine's key. So that the gateway can tell the
 * daemon what the task cost, the daemon — and only the daemon — marks every
 * gateway call of that chat with the app's id:
 *
 * - Uno (OpenCode engine): an `X-Uno-App` header on the Uno providers in the
 *   session's `OPENCODE_CONFIG_CONTENT`;
 * - Hermes: a base URL `…/v1/apps/<id>` (the OpenAI SDK it uses takes no
 *   extra headers from the environment; the gateway serves the same routes
 *   there).
 *
 * Claude Code, Codex, Cursor and plain OpenCode don't use the Uno gateway —
 * they run on the person's own subscription or keys, so Uno charges nothing
 * for their tasks and there is nothing to count against the app's limit.
 *
 * The label is analytics inside the machine's key, not a permission: the
 * gateway charges the key's owner as usual and shows the sums only to the
 * holder of the same key. An app never sees or sets it.
 */
export const APP_LABEL_HEADER = "X-Uno-App";

/** Same format as a manifest id (`machineApps/appManifest.ts`). */
const APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function isAppLabel(value: string): boolean {
  return APP_ID_RE.test(value);
}

/** Which app (if any) a thread works for — the daemon's map, never the thread's own words. */
export interface ThreadAppLabels {
  readonly labelThread: (threadId: string, appId: string) => void;
  readonly appOfThread: (threadId: string | undefined) => string | null;
}

export function makeThreadAppLabels(): ThreadAppLabels {
  const byThread = new Map<string, string>();
  return {
    labelThread: (threadId, appId) => {
      if (threadId.length > 0 && isAppLabel(appId)) byThread.set(threadId, appId);
    },
    appOfThread: (threadId) => (threadId ? (byThread.get(threadId) ?? null) : null),
  };
}

/** `https://…/v1` + `translator` → `https://…/v1/apps/translator`. */
export function gatewayBaseUrlForApp(baseUrl: string, appId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/apps/${appId}`;
}

/**
 * The OpenCode config of an app thread: the same config, with the app label
 * header on every provider that talks to the Uno gateway. Returns the input
 * unchanged when it isn't JSON or has none of those providers.
 */
export function withAppLabelHeaders(
  configContent: string | undefined,
  appId: string,
  gatewayProviderIds: ReadonlyArray<string>,
): string | undefined {
  if (!configContent || !isAppLabel(appId)) return configContent;
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configContent) as Record<string, unknown>;
  } catch {
    return configContent;
  }
  const providers = config["provider"];
  if (typeof providers !== "object" || providers === null) return configContent;
  let changed = false;
  const next: Record<string, unknown> = { ...(providers as Record<string, unknown>) };
  for (const id of gatewayProviderIds) {
    const provider = next[id];
    if (typeof provider !== "object" || provider === null) continue;
    const p = provider as Record<string, unknown>;
    const options = (
      typeof p["options"] === "object" && p["options"] !== null ? p["options"] : {}
    ) as Record<string, unknown>;
    const headers = (
      typeof options["headers"] === "object" && options["headers"] !== null
        ? options["headers"]
        : {}
    ) as Record<string, unknown>;
    next[id] = {
      ...p,
      options: { ...options, headers: { ...headers, [APP_LABEL_HEADER]: appId } },
    };
    changed = true;
  }
  return changed ? JSON.stringify({ ...config, provider: next }) : configContent;
}
