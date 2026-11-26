/**
 * AntigravityProvider — snapshot / status of Google Antigravity's ACP agent.
 *
 * The periodic check is cheap: find `agy` (AntigravityInstallation), its
 * `--version`, and the sign-in (file, keyring item or API key — no network,
 * no ACP session). The models are the ones the runtime lists for this
 * account in `session/new`: learnt from the first chat, or once per daemon
 * from a short probe session as soon as Antigravity is signed in, with each
 * model's thinking levels as its option (upstream T3 Code
 * buildAntigravityModelsFromSession).
 *
 * @module AntigravityProvider
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type AntigravitySettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ANTIGRAVITY_ACP_ARGS,
  ANTIGRAVITY_DISPLAY_NAME,
  type AntigravityAuthState,
  antigravityAuthMethodFor,
  antigravityClientInfo,
  antigravityCredentialStore,
  antigravityModelOptions,
  antigravityProcessEnvironment,
  antigravityThinkingConfig,
  findLinuxCaBundle,
  isAntigravityVersionSupported,
  probeAntigravityAuth,
} from "../acp/AntigravityAcpSupport.ts";
import {
  type AntigravityExecutableSource,
  resolveAntigravityExecutable,
} from "../AntigravityInstallation.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { antigravityVersionOf } from "./AntigravityAdapter.ts";

type ConfigOption = EffectAcpSchema.SessionConfigOption;
type ThinkingConfig = NonNullable<ReturnType<typeof antigravityThinkingConfig>>;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

export const ANTIGRAVITY_PRESENTATION = {
  displayName: ANTIGRAVITY_DISPLAY_NAME,
  // agy plans with its own tools and /plan; there is no ACP plan mode to switch to.
  showInteractionModeToggle: false,
} as const;

/** What a chat can show before Antigravity lists this account's models. */
const DEFAULT_ENTRY: ServerProviderModel = {
  slug: ANTIGRAVITY_DEFAULT_MODEL,
  name: "Antigravity default",
  isDefault: true,
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

function thinkingCapabilities(config: ThinkingConfig | null | undefined): ModelCapabilities {
  if (!config) return EMPTY_CAPABILITIES;
  const options = config.options
    .flatMap((entry) => ("value" in entry ? [entry] : entry.options))
    .filter((entry) => entry.value.trim() && entry.name.trim());
  if (options.length === 0) return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: config.id,
        label: config.name.trim() || "Thinking",
        type: "select",
        options: options.map((entry) => ({
          id: entry.value,
          label: entry.name,
          ...(entry.value === config.currentValue ? { isDefault: true } : {}),
        })),
        ...(config.currentValue ? { currentValue: config.currentValue } : {}),
      },
    ],
  });
}

/**
 * What the agent last listed, per model: thinking levels of the models
 * seen selected (`null`: that model has none).
 */
export interface AntigravityObservedModels {
  readonly configOptions: ReadonlyArray<ConfigOption>;
  readonly thinking: ReadonlyMap<string, ThinkingConfig | null>;
}

/** Remembers a session's config options; returns whether the picker changes. */
export function observeAntigravityConfig(
  previous: AntigravityObservedModels | undefined,
  configOptions: ReadonlyArray<ConfigOption>,
): AntigravityObservedModels | undefined {
  if (antigravityModelOptions(configOptions).length === 0) return undefined;
  const model = configOptions.find((option) => option.id === "model");
  const thinking = new Map(previous?.thinking ?? []);
  if (model?.type === "select") {
    thinking.set(model.currentValue, antigravityThinkingConfig(configOptions) ?? null);
  }
  return { configOptions, thinking };
}

export function buildAntigravityModels(
  config: Pick<AntigravitySettings, "customModels">,
  observed: AntigravityObservedModels | undefined,
): ReadonlyArray<ServerProviderModel> {
  const models: Array<ServerProviderModel> = [];
  const seen = new Set<string>();
  const modelConfig = observed?.configOptions.find((option) => option.id === "model");
  const current = modelConfig?.type === "select" ? modelConfig.currentValue : undefined;
  const names = new Set<string>();
  for (const entry of observed ? antigravityModelOptions(observed.configOptions) : []) {
    const slug = entry.value.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const baseName = entry.name.trim() || slug;
    // Two ids under one name: the later ones carry their id (upstream).
    const name = names.has(baseName) ? `${baseName} (${slug})` : baseName;
    names.add(baseName);
    models.push({
      slug,
      name,
      ...(slug === current ? { isDefault: true, aliases: [ANTIGRAVITY_DEFAULT_MODEL] } : {}),
      isCustom: false,
      capabilities: thinkingCapabilities(observed?.thinking.get(slug)),
    });
  }
  if (models.length === 0) models.push(DEFAULT_ENTRY);
  for (const custom of config.customModels) {
    const slug = custom.trim();
    if (!slug || seen.has(slug) || slug === ANTIGRAVITY_DEFAULT_MODEL) continue;
    seen.add(slug);
    models.push({ slug, name: slug, isCustom: true, capabilities: EMPTY_CAPABILITIES });
  }
  return models;
}

export function buildInitialAntigravitySnapshot(config: AntigravitySettings): ServerProviderDraft {
  return buildServerProvider({
    presentation: ANTIGRAVITY_PRESENTATION,
    enabled: config.enabled,
    checkedAt: new Date().toISOString(),
    models: buildAntigravityModels(config, undefined),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: config.enabled ? "Checking Antigravity…" : "Antigravity is turned off.",
    },
  });
}

export interface AntigravityStatus {
  readonly snapshot: ServerProviderDraft;
  /** The runtime a chat would start, when it can start. */
  readonly executable?: string;
  readonly version?: string;
  readonly source?: AntigravityExecutableSource;
  readonly auth?: AntigravityAuthState;
}

export async function checkAntigravityStatus(input: {
  readonly config: AntigravitySettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly observed: AntigravityObservedModels | undefined;
}): Promise<AntigravityStatus> {
  const { config } = input;
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]) =>
    buildServerProvider({
      presentation: ANTIGRAVITY_PRESENTATION,
      enabled: config.enabled,
      checkedAt: new Date().toISOString(),
      models: buildAntigravityModels(config, input.observed),
      probe,
    });
  if (!config.enabled) {
    return {
      snapshot: build({
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Antigravity is turned off in Uno Work settings.",
      }),
    };
  }
  const executable = await resolveAntigravityExecutable({
    binaryPath: config.binaryPath,
    env: input.environment,
  });
  if (!executable.ok) {
    return {
      snapshot: build({
        installed: false,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Antigravity is not installed. Install it from Settings → AI → Antigravity.",
      }),
    };
  }
  const version = await antigravityVersionOf(executable.path, input.environment);
  const auth = await probeAntigravityAuth(input.environment);
  const snapshotAuth = {
    status: auth.status,
    ...(auth.type ? { type: auth.type } : {}),
    ...(auth.label ? { label: auth.label } : {}),
  } as const;
  const base = {
    executable: executable.path,
    source: executable.source,
    auth,
    ...(version ? { version } : {}),
  };
  if (!isAntigravityVersionSupported(version)) {
    return {
      ...base,
      snapshot: build({
        installed: true,
        version: version ?? null,
        status: "error",
        auth: snapshotAuth,
        message: `Antigravity ${version} is too old for chats. Update it from Settings → AI → Antigravity.`,
      }),
    };
  }
  if (auth.status === "unauthenticated") {
    return {
      ...base,
      snapshot: build({
        installed: true,
        version: version ?? null,
        status: "error",
        auth: snapshotAuth,
        message: `Antigravity is not signed in. ${auth.message ?? ""}`.trim(),
      }),
    };
  }
  return {
    ...base,
    snapshot: build({
      installed: true,
      version: version ?? null,
      status: version ? "ready" : "warning",
      auth: snapshotAuth,
      ...(version ? {} : { message: "`agy --version` did not answer." }),
    }),
  };
}

/* ------------------------------------------------------------------ *
 * One short session to learn this account's models
 * ------------------------------------------------------------------ */

/**
 * `initialize` → `authenticate` → `session/new` in an empty folder, then
 * the process is stopped: the models and thinking levels this account has.
 * No prompt is sent, nothing is billed.
 */
export async function probeAntigravityConfigOptions(input: {
  readonly executable: string;
  readonly version: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly clientVersion: string;
  readonly timeoutMs?: number;
}): Promise<ReadonlyArray<ConfigOption> | undefined> {
  const cwd = await mkdtemp(nodePath.join(os.tmpdir(), "uno-antigravity-probe-"));
  const caBundlePath = await findLinuxCaBundle(input.environment);
  const env = antigravityProcessEnvironment(input.environment, {
    store: await antigravityCredentialStore(input.environment),
    ...(caBundlePath ? { caBundlePath } : {}),
  });
  const child = spawn(input.executable, [...ANTIGRAVITY_ACP_ARGS], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  const pending = new Map<number, (message: { result?: unknown; error?: unknown }) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown };
        if (typeof message.id === "number" && pending.has(message.id)) {
          pending.get(message.id)!(message);
          pending.delete(message.id);
        } else if (message.id !== undefined && "method" in message) {
          // A request from the agent (permission, fs): refuse, the probe does nothing.
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not supported" } })}\n`,
          );
        }
      } catch {
        // Not JSON-RPC: ignore.
      }
    }
  });
  let nextId = 1;
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (message) =>
        message.error === undefined
          ? resolve(message.result)
          : reject(new Error(JSON.stringify(message.error))),
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const timeout = new Promise<undefined>((resolve) =>
    setTimeout(() => resolve(undefined), input.timeoutMs ?? 60_000).unref(),
  );
  const exited = new Promise<undefined>((resolve) => {
    child.once("exit", () => resolve(undefined));
    child.once("error", () => resolve(undefined));
  });
  try {
    return await Promise.race([
      (async () => {
        await request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: antigravityClientInfo(input.version, input.clientVersion),
        });
        await request("authenticate", { methodId: antigravityAuthMethodFor(input.environment) });
        const session = (await request("session/new", { cwd, mcpServers: [] })) as {
          configOptions?: ReadonlyArray<ConfigOption> | null;
        };
        return session?.configOptions ?? undefined;
      })().catch(() => undefined),
      timeout,
      exited,
    ]);
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
