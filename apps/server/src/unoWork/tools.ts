/**
 * The `uno-work` MCP server: what every AI in Uno Work can do with the
 * environment, whatever harness it runs in (built-in Uno, OpenCode, Claude,
 * Codex, Cursor, Hermes, custom ACP harnesses).
 *
 * Tools act for ONE chat: the caller is the thread named by the per-thread
 * bridge token the harness was started with — never an id from arguments.
 * Everything already reachable over the bridge HTTP API (open in the panel,
 * browser commands, secrets, chats) is called through that same API with the
 * same token, so rules live in one place. The rest (apps, files, cloud,
 * Inbox, account, settings) calls the daemon's services directly.
 *
 * Every tool declares a level (see `policy.ts`); the gate runs here, before
 * the tool, so the approval rules are the same in every harness.
 */
import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";

import type {
  FilesCloudListResult,
  FilesCloudState,
  FilesEntry,
  FilesListResult,
  FilesPublishSiteResult,
  FilesShare,
  InboxOpenTarget,
  RuntimeMode,
  ServerSettings,
  UnoBoxCreateJobStatus,
  UnoCloudCreateBoxResult,
  UnoCloudState,
  UnoComputerResizeOptions,
  UnoComputerResources,
  UnoComputerState,
  UnoMachineApp,
  UnoMachineAppActionInput,
  UnoMachineApps,
} from "@t3tools/contracts";
import { clampUnoAgentAccessLevel } from "@t3tools/contracts";
import { Data, Effect } from "effect";

import { validateManifest } from "../machineApps/appManifest.ts";
import { displayManifestDir } from "../machineApps/manifestDir.ts";
import type { InboxPost } from "../inbox/inboxModel.ts";
import type { ToolApprovalOutcome } from "../browserBridge.ts";
import { McpContent, type McpServerDefinition } from "../mcp/mcpJsonRpc.ts";
import {
  buildUnoWorkGuide,
  UNO_WORK_GUIDE_TOPICS,
  isUnoWorkGuideTopic,
} from "../agentContext/guides.ts";
import { validateArgs, type ObjectSchema } from "./argsSchema.ts";
import { decideUnoWorkGate, refusalMessage, type UnoWorkToolLevel } from "./policy.ts";

import { UNO_WORK_MCP_SERVER_NAME } from "./constants.ts";

export {
  UNO_WORK_APPROVAL_RESULT_PATH,
  UNO_WORK_GUIDE_PATH,
  UNO_WORK_MCP_PATH,
  UNO_WORK_MCP_SERVER_NAME,
} from "./constants.ts";

export class UnoWorkToolError extends Data.TaggedError("UnoWorkToolError")<{
  readonly message: string;
}> {}

const toolError = (message: string) => new UnoWorkToolError({ message });

/** Any failure with a message → a tool error the model can read. */
const asToolError = <A, E extends { readonly message: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, UnoWorkToolError, R> =>
  effect.pipe(Effect.mapError((cause) => toolError(cause.message)));

// ── Dependencies ───────────────────────────────────────────────────────

export interface UnoWorkCaller {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly runtimeMode: RuntimeMode;
  /** The chat's working folder, when known. */
  readonly cwd: string | undefined;
}

export interface BridgeReply {
  readonly status: number;
  readonly body: unknown;
}

export interface UnoWorkToolDeps {
  readonly caller: UnoWorkCaller;
  readonly home: string;
  /** `~/.uno/apps` (absolute). */
  readonly manifestDir: string;
  /** The daemon's plugins folder (for `uno_guide("plugins")`). */
  readonly pluginsDir: string;
  /** The bridge HTTP API of this daemon, called with the caller's own token. */
  readonly bridge: (input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: unknown;
    readonly timeoutMs?: number;
  }) => Effect.Effect<BridgeReply, UnoWorkToolError>;
  readonly requestApproval: (input: {
    readonly tool: string;
    readonly title: string;
    readonly detail?: string;
    readonly sensitive: boolean;
  }) => Effect.Effect<ToolApprovalOutcome>;
  readonly machineApps: {
    readonly list: Effect.Effect<UnoMachineApps>;
    readonly action: (
      input: UnoMachineAppActionInput,
    ) => Effect.Effect<UnoMachineApps, { readonly message: string }>;
  };
  readonly resources: Effect.Effect<UnoComputerResources>;
  readonly computerState: Effect.Effect<UnoComputerState>;
  readonly files: {
    readonly list: (input: {
      readonly path?: string;
      readonly showHidden?: boolean;
    }) => Effect.Effect<FilesListResult, { readonly message: string }>;
    readonly stat: (input: {
      readonly path: string;
    }) => Effect.Effect<FilesEntry, { readonly message: string }>;
    readonly createShare: (input: {
      readonly path: string;
      readonly access?: "view" | "comment" | "edit";
      readonly expiresInSeconds?: number | null;
    }) => Effect.Effect<FilesShare, { readonly message: string }>;
    readonly publishSite: (input: {
      readonly path: string;
      readonly slug?: string;
    }) => Effect.Effect<FilesPublishSiteResult, { readonly message: string }>;
    readonly cloudState: Effect.Effect<FilesCloudState, { readonly message: string }>;
    readonly cloudList: (input: {
      readonly bucketId: number;
      readonly prefix?: string;
    }) => Effect.Effect<FilesCloudListResult, { readonly message: string }>;
  };
  readonly inboxPost: (post: InboxPost) => Effect.Effect<{ readonly id: string }>;
  readonly messengerNotify: (input: {
    readonly text: string;
    readonly kind: "info" | "warning" | "error";
  }) => Effect.Effect<{ readonly delivered: number }>;
  readonly openInApp: (input: {
    readonly view: "office" | "files";
    readonly path: string;
  }) => Effect.Effect<{ readonly ok: boolean; readonly error?: string }>;
  readonly account: {
    readonly cloudState: Effect.Effect<UnoCloudState>;
    readonly resizeOptions: Effect.Effect<UnoComputerResizeOptions>;
    readonly createBox: (input: {
      readonly name: string;
      readonly ramMb?: number;
      readonly vcpu?: number;
      readonly diskGb?: number;
      readonly purpose?: "work";
    }) => Effect.Effect<UnoCloudCreateBoxResult, { readonly message: string }>;
    readonly createBoxStatus: (input: {
      readonly jobId: string;
    }) => Effect.Effect<UnoBoxCreateJobStatus, { readonly message: string }>;
  };
  readonly settings: Effect.Effect<ServerSettings, { readonly message: string }>;
  readonly readLogTail: (input: {
    readonly app: UnoMachineApp;
    readonly lines: number;
  }) => Effect.Effect<string>;
}

// ── Tool definition ────────────────────────────────────────────────────

export type UnoWorkGroup =
  | "computer"
  | "apps"
  | "files"
  | "chats"
  | "person"
  | "sites"
  | "account"
  | "settings"
  | "docs";

export interface UnoWorkTool {
  readonly name: string;
  readonly group: UnoWorkGroup;
  readonly description: string;
  readonly inputSchema: ObjectSchema;
  /** Fixed level, or one that depends on the arguments (browser commands). */
  readonly level: UnoWorkToolLevel | ((args: Record<string, unknown>) => UnoWorkToolLevel);
  /** The approval card's line, e.g. `Show “Notes” on the internet`. */
  readonly approvalTitle?: (args: Record<string, unknown>) => string;
  readonly approvalDetail?: (args: Record<string, unknown>) => string | undefined;
  readonly run: (
    deps: UnoWorkToolDeps,
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, UnoWorkToolError>;
}

export function toolLevel(tool: UnoWorkTool, args: Record<string, unknown>): UnoWorkToolLevel {
  return typeof tool.level === "function" ? tool.level(args) : tool.level;
}

// ── Helpers ────────────────────────────────────────────────────────────

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === "string" ? (args[key] as string) : undefined;
const num = (args: Record<string, unknown>, key: string): number | undefined =>
  typeof args[key] === "number" ? (args[key] as number) : undefined;
const bool = (args: Record<string, unknown>, key: string): boolean | undefined =>
  typeof args[key] === "boolean" ? (args[key] as boolean) : undefined;

/** `~/x`, `/abs` or a path relative to the chat's folder (then home). */
export function resolveUserPath(raw: string, deps: Pick<UnoWorkToolDeps, "home" | "caller">) {
  const value = raw.trim();
  if (value === "~") return deps.home;
  if (value.startsWith("~/")) return path.join(deps.home, value.slice(2));
  if (path.isAbsolute(value)) return path.normalize(value);
  return path.resolve(deps.caller.cwd ?? deps.home, value);
}

/** Spell a path for a person: `~/projects/notes`. */
export function displayPath(absolute: string, home: string): string {
  if (absolute === home) return "~";
  return absolute.startsWith(`${home}${path.sep}`)
    ? `~/${absolute.slice(home.length + 1)}`
    : absolute;
}

function compactApp(app: UnoMachineApp) {
  return {
    id: app.id,
    name: app.name,
    status: app.status,
    source: app.source,
    ...(app.port !== null ? { port: app.port } : {}),
    ...(app.localUrl ? { localUrl: app.localUrl } : {}),
    ...(app.url ? { url: app.url } : {}),
    ...(app.publication ? { onInternet: app.publication } : {}),
    ...(app.loopbackOnly ? { loopbackOnly: true } : {}),
    ...(app.detail ? { detail: app.detail } : {}),
    ...(app.codeDir ? { codeDir: app.codeDir } : {}),
    ...(app.widget ? { widget: app.widget } : {}),
    ...(app.hidden ? { hidden: true } : {}),
    canStart: app.canStart,
    canStop: app.canStop,
    ...(app.canRemove ? { canRemove: true } : {}),
  };
}

const findApp = (deps: UnoWorkToolDeps, rawId: string) =>
  deps.machineApps.list.pipe(
    Effect.flatMap((apps) => {
      const wanted = rawId.trim();
      const app =
        apps.apps.find((entry) => entry.id === wanted) ??
        apps.apps.find((entry) => entry.id === `manifest:${wanted}`) ??
        apps.apps.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
      return app
        ? Effect.succeed(app)
        : Effect.fail(
            toolError(
              `No app "${wanted}" on this computer. Call apps_list for the ids (e.g. "manifest:notes", "docker:web", "port:3000").`,
            ),
          );
    }),
  );

const appAction = (
  deps: UnoWorkToolDeps,
  args: Record<string, unknown>,
  action: UnoMachineAppActionInput["action"],
) =>
  Effect.gen(function* () {
    const app = yield* findApp(deps, str(args, "appId") ?? "");
    const result = yield* asToolError(
      deps.machineApps.action({
        appId: app.id,
        action,
        ...(action === "remove" && bool(args, "deleteCode") ? { deleteCode: true } : {}),
      }),
    );
    const after = result.apps.find((entry) => entry.id === app.id);
    return {
      ok: true,
      app: after ? compactApp(after) : { id: app.id, removed: action === "remove" },
      ...(action === "publish" && result.publishBlockedReason
        ? { note: result.publishBlockedReason }
        : {}),
    };
  });

const appIdLabel = (args: Record<string, unknown>) => str(args, "appId") ?? "an app";

const MANIFEST_ID_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";

const manifestPath = (deps: UnoWorkToolDeps, id: string) =>
  path.join(deps.manifestDir, `${id}.json`);

const readManifestRecord = (deps: UnoWorkToolDeps, id: string) =>
  Effect.tryPromise({
    try: async () => JSON.parse(await fsp.readFile(manifestPath(deps, id), "utf8")) as unknown,
    catch: () =>
      toolError(
        `No registered app "${id}" (no ${displayManifestDir(manifestPath(deps, id), deps.home)}). Register it with app_register first.`,
      ),
  }).pipe(
    Effect.flatMap((raw) =>
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? Effect.succeed(raw as Record<string, unknown>)
        : Effect.fail(toolError(`The manifest of "${id}" is not a JSON object.`)),
    ),
  );

const writeManifestRecord = (deps: UnoWorkToolDeps, id: string, record: Record<string, unknown>) =>
  Effect.gen(function* () {
    const checked = validateManifest(id, record, {
      home: deps.home,
      manifestDir: deps.manifestDir,
    });
    if (!checked.ok) {
      return yield* toolError(`The app manifest ${checked.reason}.`);
    }
    const target = manifestPath(deps, id);
    yield* Effect.tryPromise({
      try: async () => {
        await fsp.mkdir(deps.manifestDir, { recursive: true });
        const temp = `${target}.${process.pid}.tmp`;
        await fsp.writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        await fsp.rename(temp, target);
      },
      catch: (cause) =>
        toolError(`Could not write ${target}: ${cause instanceof Error ? cause.message : cause}`),
    });
    return { manifest: checked.manifest, file: displayManifestDir(target, deps.home) };
  });

function accountAccess(settings: ServerSettings) {
  const linked = settings.uno.apiKey.trim().length > 0;
  const level = clampUnoAgentAccessLevel(settings.uno.agentAccess);
  return { linked, level };
}

const ACCESS_OFF_MESSAGE =
  "The person turned agent access to their Uno account off (Settings → Uno account → Agent access). Tell them what you wanted to look up; don't try other ways.";

const openTargetSchema: ObjectSchema = {
  type: "object",
  description:
    'Where "Open" on the notification leads. Default: this chat. Give exactly one of file, appId or url.',
  properties: {
    file: {
      type: "string",
      description: "A file inside the home folder, e.g. ~/Documents/report.docx.",
    },
    appId: { type: "string", description: 'A registered app id, e.g. "notes".' },
    appPath: { type: "string", description: 'A path inside that app, e.g. "/orders".' },
    url: { type: "string", description: "An https:// address." },
  },
  additionalProperties: false,
};

function openTargetFrom(raw: unknown, deps: UnoWorkToolDeps): InboxOpenTarget {
  const fallback: InboxOpenTarget = { kind: "thread", threadId: deps.caller.threadId };
  if (typeof raw !== "object" || raw === null) return fallback;
  const record = raw as Record<string, unknown>;
  if (typeof record.file === "string" && record.file.trim()) {
    return { kind: "file", path: resolveUserPath(record.file, deps) };
  }
  if (typeof record.appId === "string" && record.appId.trim()) {
    return {
      kind: "app",
      appId: record.appId.replace(/^manifest:/, "").trim(),
      path:
        typeof record.appPath === "string" && record.appPath.startsWith("/")
          ? record.appPath
          : null,
    };
  }
  if (typeof record.url === "string" && /^https?:\/\//i.test(record.url.trim())) {
    return { kind: "url", url: record.url.trim() };
  }
  return fallback;
}

/** Bridge replies: 2xx → body; anything else → the reason from the body. */
const bridgeOk = (reply: BridgeReply): Effect.Effect<unknown, UnoWorkToolError> => {
  if (reply.status >= 200 && reply.status < 300) return Effect.succeed(reply.body);
  const body = reply.body;
  const reason =
    typeof body === "string"
      ? body
      : typeof body === "object" && body !== null
        ? String(
            (body as { message?: unknown }).message ??
              (body as { error?: unknown }).error ??
              JSON.stringify(body),
          )
        : `HTTP ${reply.status}`;
  return Effect.fail(toolError(`${reason} (HTTP ${reply.status})`));
};

function isLocalAddress(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "[::1]";
  } catch {
    return false;
  }
}

export function isCompleteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
  } catch {
    return false;
  }
}

function joinUrlPath(base: string, extra: string | undefined): string {
  if (!extra) return base;
  try {
    const url = new URL(base);
    const [pathname = "", search = ""] = extra.split("?", 2);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
    if (search) url.search = search;
    return url.toString();
  } catch {
    return base;
  }
}

const threadPath = (raw: string | undefined) => {
  const id = (raw ?? "").trim();
  return /^[A-Za-z0-9:_-]{1,200}$/.test(id) ? encodeURIComponent(id) : null;
};

// ── The tools ──────────────────────────────────────────────────────────

const noArgs: ObjectSchema = { type: "object", properties: {}, additionalProperties: false };
const appIdArg = {
  type: "string" as const,
  description:
    'The app: its id from apps_list ("manifest:notes", "docker:web", "port:3000") or, for apps you registered, just "notes".',
  minLength: 1,
  maxLength: 200,
};

export const UNO_WORK_TOOLS: ReadonlyArray<UnoWorkTool> = [
  // This computer
  {
    name: "computer_status",
    group: "computer",
    description:
      "Where you are: this computer's name and system, whether it is an Uno cloud computer (and its address, size, plan boost), CPU/memory/disk use, the biggest things running, how many apps it has, and where the home folder, apps folder and SDK are. Call it first when you need to know the environment.",
    inputSchema: noArgs,
    level: "safe",
    run: (deps) =>
      Effect.gen(function* () {
        const [resources, apps, computer] = yield* Effect.all(
          [
            deps.resources,
            deps.machineApps.list,
            deps.computerState.pipe(
              Effect.timeoutOption("4 seconds"),
              Effect.map((option) => (option._tag === "Some" ? option.value : null)),
            ),
          ],
          { concurrency: "unbounded" },
        );
        const box = computer?.own ? computer.box : null;
        return {
          hostname: os.hostname(),
          platform: resources.platform,
          home: deps.home,
          chatFolder: deps.caller.cwd ? displayPath(deps.caller.cwd, deps.home) : null,
          appsFolder: displayManifestDir(deps.manifestDir, deps.home),
          sdkFolder: "~/.uno/sdk",
          unoCloudComputer: box
            ? {
                id: box.id,
                name: box.name,
                status: box.status,
                address: box.address,
                ramMb: box.ramMb,
                vcpu: box.vcpu,
                diskGb: box.diskGb,
                ...(box.boost
                  ? { boostHoursLeft: box.boost.hoursLeft, boostActive: box.boost.state }
                  : {}),
              }
            : null,
          linkedToUnoAccount: computer?.linked ?? null,
          cpu: { count: resources.cpuCount, usedPct: resources.cpuPct, load1: resources.load1 },
          memoryMb: {
            total: resources.memory.totalMb,
            used: resources.memory.usedMb,
            available: resources.memory.availableMb,
          },
          disks: resources.volumes.map((volume) => ({
            mount: volume.mount,
            totalGb: volume.totalGb,
            freeGb: volume.freeGb,
          })),
          topUsers: resources.groups
            .toSorted((a, b) => b.memMb - a.memMb)
            .slice(0, 6)
            .map((group) => ({
              name: group.name,
              kind: group.kind,
              cpuPct: Math.round(group.cpuPct),
              memMb: Math.round(group.memMb),
            })),
          apps: {
            total: apps.apps.length,
            running: apps.apps.filter((app) => app.status === "running").length,
          },
          ...(apps.publishBlockedReason
            ? { showOnInternetUnavailable: apps.publishBlockedReason }
            : {}),
          notes: resources.notes,
        };
      }),
  },
  {
    name: "apps_list",
    group: "computer",
    description:
      "List the apps on this computer's Home: ones registered in ~/.uno/apps (id manifest:<id>), docker containers, services and other listening ports. Shows status, port, local URL, whether it is shown on the internet, its widget and what you can do with it.",
    inputSchema: {
      type: "object",
      properties: {
        includeHidden: { type: "boolean", description: "Also list apps the person hid from Home." },
      },
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      deps.machineApps.list.pipe(
        Effect.map((apps) => ({
          appsFolder: apps.manifestDir,
          apps: apps.apps
            .filter((app) => bool(args, "includeHidden") || !app.hidden)
            .map(compactApp),
          ...(apps.publishBlockedReason
            ? { showOnInternetUnavailable: apps.publishBlockedReason }
            : {}),
          ...(apps.warnings.length > 0 ? { manifestWarnings: apps.warnings } : {}),
        })),
      ),
  },
  {
    name: "app_start",
    group: "computer",
    description: "Start an app that is stopped (its Start button on Home).",
    inputSchema: {
      type: "object",
      properties: { appId: appIdArg },
      required: ["appId"],
      additionalProperties: false,
    },
    level: "change",
    approvalTitle: (args) => `Start ${appIdLabel(args)}`,
    run: (deps, args) => appAction(deps, args, "start"),
  },
  {
    name: "app_stop",
    group: "computer",
    description: "Stop a running app (its Stop button on Home). It can be started again.",
    inputSchema: {
      type: "object",
      properties: { appId: appIdArg },
      required: ["appId"],
      additionalProperties: false,
    },
    level: "change",
    approvalTitle: (args) => `Stop ${appIdLabel(args)}`,
    run: (deps, args) => appAction(deps, args, "stop"),
  },
  {
    name: "app_logs",
    group: "computer",
    description:
      "The last lines an app printed: ~/.uno/apps/<id>.log for registered apps, docker logs for containers, the journal for services. Use it when an app doesn't start or misbehaves.",
    inputSchema: {
      type: "object",
      properties: {
        appId: appIdArg,
        lines: { type: "integer", minimum: 1, maximum: 500, description: "Default 80." },
      },
      required: ["appId"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      Effect.gen(function* () {
        const app = yield* findApp(deps, str(args, "appId") ?? "");
        const text = yield* deps.readLogTail({ app, lines: num(args, "lines") ?? 80 });
        return `${app.name} (${app.id}, ${app.status}):\n${text || "(no output recorded)"}`;
      }),
  },
  {
    name: "app_show_on_internet",
    group: "computer",
    description:
      'Give a running web app a public https address so it opens from anywhere (the "Show on the internet" button). Anyone with the address can reach it — the person always approves this. The app must listen on 0.0.0.0, not only 127.0.0.1.',
    inputSchema: {
      type: "object",
      properties: { appId: appIdArg },
      required: ["appId"],
      additionalProperties: false,
    },
    level: "sensitive",
    approvalTitle: (args) => `Show ${appIdLabel(args)} on the internet`,
    approvalDetail: () => "Anyone with the address will be able to open it.",
    run: (deps, args) => appAction(deps, args, "publish"),
  },
  {
    name: "app_hide_from_internet",
    group: "computer",
    description: "Take an app's public address away again. It keeps running on this computer.",
    inputSchema: {
      type: "object",
      properties: { appId: appIdArg },
      required: ["appId"],
      additionalProperties: false,
    },
    level: "change",
    approvalTitle: (args) => `Hide ${appIdLabel(args)} from the internet`,
    run: (deps, args) => appAction(deps, args, "unpublish"),
  },
  {
    name: "app_remove",
    group: "computer",
    description:
      "Remove an app from this computer: stops it, deletes its manifest (registered apps) or container (docker, volumes kept) and withdraws its App SDK token. deleteCode also deletes its code folder. Always asks the person.",
    inputSchema: {
      type: "object",
      properties: {
        appId: appIdArg,
        deleteCode: {
          type: "boolean",
          description: "Also delete the app's code folder (default false — code stays).",
        },
      },
      required: ["appId"],
      additionalProperties: false,
    },
    level: "sensitive",
    approvalTitle: (args) => `Remove ${appIdLabel(args)} from this computer`,
    approvalDetail: (args) =>
      bool(args, "deleteCode") ? "Its code folder will be deleted too." : "Its code folder stays.",
    run: (deps, args) => appAction(deps, args, "remove"),
  },

  // Apps & widgets
  {
    name: "app_register",
    group: "apps",
    description:
      "Put an app you built on the person's Home: writes and validates ~/.uno/apps/<id>.json. With a command, Uno starts it within ~20 seconds and after every reboot (don't start a second copy), logging to ~/.uno/apps/<id>.log. Registering the same id again updates it. Ask for the machine's AI, cloud storage or Inbox notifications with ai / storage / notify (then use the Uno App SDK — uno_guide('app-sdk')). Never put secrets here.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          pattern: MANIFEST_ID_PATTERN,
          description: "Short lowercase id: letters, digits, - and _, e.g. notes.",
        },
        name: { type: "string", minLength: 1, maxLength: 60, description: "What the person sees." },
        icon: {
          type: "string",
          maxLength: 80,
          description: "One emoji, or an image file name placed in ~/.uno/apps.",
        },
        description: { type: "string", maxLength: 200 },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "TCP port it listens on (0.0.0.0).",
        },
        command: {
          type: "string",
          maxLength: 2000,
          description:
            'How Uno starts it (bash -lc in cwd, PORT is set), e.g. "python3 app.py". Give it for anything you built so it has a Start button and survives reboots.',
        },
        cwd: { type: "string", description: "Its folder inside home, e.g. ~/projects/notes." },
        path: { type: "string", description: 'What to open on the port, e.g. "/admin".' },
        url: {
          type: "string",
          description:
            "Only for an app hosted somewhere else (an https address). Leave it out for apps on this computer — use port + command.",
        },
        autostart: { type: "boolean", description: "Start at boot (default true with a command)." },
        ai: {
          type: "object",
          description: "Use the computer's AI through the App SDK.",
          properties: {
            chat: { type: "boolean" },
            tasks: { type: "boolean" },
            limitUsd: { type: "number", minimum: 0, maximum: 10 },
          },
          additionalProperties: false,
        },
        storage: {
          type: "object",
          description: "Its own cloud folder (Cloud storage → apps/<id>/).",
          properties: { limitGb: { type: "integer", minimum: 1, maximum: 20 } },
          additionalProperties: false,
        },
        notify: { type: "boolean", description: "May put notifications into the person's Inbox." },
      },
      required: ["id", "name"],
      additionalProperties: false,
    },
    level: "change",
    approvalTitle: (args) => `Register the app “${str(args, "name") ?? str(args, "id")}” on Home`,
    approvalDetail: (args) => str(args, "command"),
    run: (deps, args) =>
      Effect.gen(function* () {
        const id = str(args, "id")!;
        // Keep a widget registered earlier: app_register updates, app_add_widget adds.
        const previous = yield* readManifestRecord(deps, id).pipe(
          Effect.orElseSucceed(() => ({}) as Record<string, unknown>),
        );
        const record: Record<string, unknown> = {};
        for (const key of [
          "name",
          "icon",
          "description",
          "port",
          "command",
          "cwd",
          "path",
          "url",
          "autostart",
          "ai",
          "notify",
        ]) {
          if (args[key] !== undefined && args[key] !== null) record[key] = args[key];
        }
        if (args.storage !== undefined && args.storage !== null) {
          const limitGb = (args.storage as { limitGb?: unknown }).limitGb;
          record.storage = typeof limitGb === "number" ? { limitGb } : true;
        }
        if (previous.widget !== undefined) record.widget = previous.widget;
        // Models often put a path ("/widget") or a local address in `url`,
        // which is only for apps hosted elsewhere. Be forgiving: a path
        // becomes `path`, a local address is dropped for the port.
        const notes: Array<string> = [];
        const rawUrl = typeof record.url === "string" ? record.url.trim() : undefined;
        if (rawUrl !== undefined) {
          if (rawUrl.startsWith("/")) {
            delete record.url;
            if (record.path === undefined) record.path = rawUrl;
            notes.push(
              `"${rawUrl}" is a path, not an address, so it was saved as path. For a Home widget use app_add_widget.`,
            );
          } else if (isLocalAddress(rawUrl) && record.port !== undefined) {
            delete record.url;
            notes.push("A local address isn't needed: Uno reaches the app by its port.");
          } else if (!isCompleteHttpUrl(rawUrl)) {
            return yield* toolError(
              `url "${rawUrl}" is not an address. url is only for an app hosted somewhere else (https://…); for an app on this computer leave url out and give port + command.`,
            );
          }
        }
        const written = yield* writeManifestRecord(deps, id, record);
        return {
          ok: true,
          appId: `manifest:${id}`,
          file: written.file,
          next: written.manifest.command
            ? "Uno starts it within ~20 seconds; check with apps_list / app_logs. Then open it with open_in_panel (appId) and tell the person it is on Home."
            : 'It shows on Home, but without a command it has no Start button and won\'t come back after a reboot. Call app_register again with command (e.g. "python3 app.py") and cwd.',
          ...(notes.length > 0 ? { notes } : {}),
        };
      }),
  },
  {
    name: "app_add_widget",
    group: "apps",
    description:
      "Give a registered app a Home widget: a small live view (about 300x200 px) of a page the app serves, e.g. /widget. Serve that page first (no header, one glance of content, refreshes itself, works in light and dark). Then tell the person: Home → Customize → Add widget → the app.",
    inputSchema: {
      type: "object",
      properties: {
        appId: {
          type: "string",
          pattern: "^(manifest:)?[a-z0-9][a-z0-9_-]{0,63}$",
          description: 'The registered app id, e.g. "notes".',
        },
        path: {
          type: "string",
          pattern: "^/",
          maxLength: 300,
          description: 'A path on the app, e.g. "/widget".',
        },
        size: {
          type: "string",
          enum: ["small", "medium", "wide"],
          description: "Default medium (half a row).",
        },
        title: {
          type: "string",
          maxLength: 60,
          description: "Card title (default: the app's name).",
        },
      },
      required: ["appId", "path"],
      additionalProperties: false,
    },
    level: "change",
    approvalTitle: (args) => `Add a Home widget for ${str(args, "appId")}`,
    run: (deps, args) =>
      Effect.gen(function* () {
        const id = (str(args, "appId") ?? "").replace(/^manifest:/, "");
        const record = yield* readManifestRecord(deps, id);
        const widget = {
          path: str(args, "path")!,
          size: str(args, "size") ?? "medium",
          ...(str(args, "title") ? { title: str(args, "title") } : {}),
        };
        const alreadySet = JSON.stringify(record.widget) === JSON.stringify(widget);
        const written = alreadySet
          ? { manifest: null }
          : yield* writeManifestRecord(deps, id, { ...record, widget });
        const name = written.manifest?.name ?? (typeof record.name === "string" ? record.name : id);
        const hasAddress =
          written.manifest === null
            ? record.port !== undefined || record.url !== undefined
            : written.manifest.port !== null || written.manifest.url !== null;
        if (!hasAddress) {
          return {
            ok: true,
            warning:
              "The app has no port or url, so Home can't show the widget yet. Add a port with app_register.",
          };
        }
        // Phrased as done: models otherwise call this again and again.
        return {
          ok: true,
          widget,
          done: `${alreadySet ? "The widget was already set" : "Widget saved"}; don't call app_add_widget again. Tell the person: Home → Customize → Add widget → ${name}.`,
        };
      }),
  },

  // Files & cloud
  {
    name: "files_list",
    group: "files",
    description:
      "List a folder of this computer (default: the home folder, which the person sees as Files). Paths: ~/…, absolute, or relative to this chat's folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Folder, e.g. ~/Documents. Default: home." },
        showHidden: { type: "boolean" },
      },
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      asToolError(
        deps.files.list({
          ...(str(args, "path") ? { path: resolveUserPath(str(args, "path")!, deps) } : {}),
          ...(bool(args, "showHidden") ? { showHidden: true } : {}),
        }),
      ).pipe(
        Effect.map((result) => ({
          path: displayPath(result.path, deps.home),
          entries: result.entries.slice(0, 300).map((entry) => ({
            name: entry.name,
            kind: entry.kind,
            size: entry.kind === "file" ? entry.size : null,
            modifiedAt: entry.modifiedAt,
          })),
          ...(result.entries.length > 300 ? { truncated: result.entries.length } : {}),
        })),
      ),
  },
  {
    name: "cloud_list",
    group: "files",
    description:
      "The person's Uno cloud storage (Files → Cloud storage): without bucketId lists the buckets and usage; with bucketId lists folders and files under prefix. Apps keep their files under apps/<id>/.",
    inputSchema: {
      type: "object",
      properties: {
        bucketId: { type: "integer", minimum: 0 },
        prefix: {
          type: "string",
          maxLength: 1024,
          description: 'Folder inside the bucket, e.g. "apps/album/".',
        },
      },
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) => {
      const bucketId = num(args, "bucketId");
      if (bucketId === undefined) return asToolError(deps.files.cloudState);
      return asToolError(
        deps.files.cloudList({
          bucketId,
          ...(str(args, "prefix") ? { prefix: str(args, "prefix")! } : {}),
        }),
      );
    },
  },
  {
    name: "file_open",
    group: "files",
    description:
      'Show a file to the person. where: "panel" (default) — in the right panel of this chat (HTML, PDF, Markdown, images, CSV, JSON, XLSX…); "office" — a Word/Excel/PowerPoint document in Uno Work\'s Office; "files" — the file selected in Files.',
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "The file, e.g. ~/Documents/report.docx.",
        },
        where: { type: "string", enum: ["panel", "office", "files"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      Effect.gen(function* () {
        const absolute = resolveUserPath(str(args, "path")!, deps);
        const where = str(args, "where") ?? "panel";
        if (where === "panel") {
          return yield* deps
            .bridge({ method: "POST", path: "/api/browser/open", body: { file: absolute } })
            .pipe(Effect.flatMap(bridgeOk));
        }
        const entry = yield* asToolError(deps.files.stat({ path: absolute }));
        if (entry.kind !== "file") {
          return yield* toolError(`${displayPath(absolute, deps.home)} is not a file.`);
        }
        const result = yield* deps.openInApp({
          view: where === "office" ? "office" : "files",
          path: absolute,
        });
        if (!result.ok) return yield* toolError(result.error ?? "Could not open it.");
        return { ok: true, shown: displayPath(absolute, deps.home), in: where };
      }),
  },
  {
    name: "file_share_link",
    group: "files",
    description:
      "Make a link to a file or folder of this computer that someone else can open (view; comment/edit for Office documents). Anyone with the link gets access — the person always approves. Optionally expires.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        access: { type: "string", enum: ["view", "comment", "edit"] },
        expiresInHours: { type: "integer", minimum: 1, maximum: 24 * 90 },
      },
      required: ["path"],
      additionalProperties: false,
    },
    level: "sensitive",
    approvalTitle: (args) => `Create a share link to ${str(args, "path")}`,
    approvalDetail: (args) =>
      `Anyone with the link can ${str(args, "access") ?? "view"} it${num(args, "expiresInHours") ? ` for ${num(args, "expiresInHours")} h` : " until you revoke it"}.`,
    run: (deps, args) =>
      Effect.gen(function* () {
        const share = yield* asToolError(
          deps.files.createShare({
            path: resolveUserPath(str(args, "path")!, deps),
            ...(str(args, "access") ? { access: str(args, "access") as "view" } : {}),
            ...(num(args, "expiresInHours")
              ? { expiresInSeconds: num(args, "expiresInHours")! * 3600 }
              : {}),
          }),
        );
        const computer = yield* deps.computerState.pipe(
          Effect.timeoutOption("4 seconds"),
          Effect.map((option) => (option._tag === "Some" ? option.value : null)),
        );
        const address = computer?.own ? computer.box?.address : null;
        return {
          ok: true,
          url: address ? `${address.replace(/\/+$/, "")}${share.urlPath}` : null,
          path: share.urlPath,
          access: share.access,
          expiresAt: share.expiresAt,
          ...(address
            ? {}
            : {
                note: "This computer has no public address, so the link works only where it is reachable. The person can find it in Files → Shared.",
              }),
        };
      }),
  },

  // Chats
  {
    name: "chats_list",
    group: "chats",
    description:
      'List chats: scope "children" (default — chats you started), "project" (every chat in this project; relation self/parent/child/peer) or "all" (every project, only if the person allowed it). Shows status (running, waiting, error, idle), who is in control and the last answer.',
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["children", "project", "all"] } },
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      deps
        .bridge({
          method: "GET",
          path: `/api/threads${str(args, "scope") ? `?scope=${str(args, "scope")}` : ""}`,
        })
        .pipe(Effect.flatMap(bridgeOk)),
  },
  {
    name: "chat_create",
    group: "chats",
    description:
      "Start a new chat with an AI agent and send it a first message — to run a separate task in parallel, in another folder, or with another harness. It starts at once; the person sees you created it and can take over. cwd puts it in any folder (becomes a project); provider picks the harness (codex, claudeAgent, opencode, uno, cursor, hermes or an instance id).",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          minLength: 1,
          maxLength: 20000,
          description: "The first message, self-contained.",
        },
        title: { type: "string", maxLength: 120 },
        cwd: {
          type: "string",
          description: "Folder to work in, e.g. ~/projects/site. Default: this chat's project.",
        },
        projectId: { type: "string" },
        provider: { type: "string" },
        model: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    level: "change",
    approvalTitle: (args) =>
      `Start a new chat: “${(str(args, "title") ?? str(args, "text") ?? "").slice(0, 80)}”`,
    run: (deps, args) =>
      deps
        .bridge({
          method: "POST",
          path: "/api/threads",
          body: {
            text: str(args, "text"),
            ...(str(args, "title") ? { title: str(args, "title") } : {}),
            ...(str(args, "cwd") ? { cwd: resolveUserPath(str(args, "cwd")!, deps) } : {}),
            ...(str(args, "projectId") ? { projectId: str(args, "projectId") } : {}),
            ...(str(args, "provider") ? { provider: str(args, "provider") } : {}),
            ...(str(args, "model") ? { model: str(args, "model") } : {}),
          },
        })
        .pipe(Effect.flatMap(bridgeOk)),
  },
  {
    name: "chat_message",
    group: "chats",
    description:
      "Send a message to another chat (one you started, your parent, or a peer in this project) by its threadId. Refused when the person took over (human_in_control) or is being asked something (human_active); busy targets: pass waitMs to deliver when free. After messaging another agent, end your turn — its answer arrives as a new message.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1 },
        text: { type: "string", minLength: 1, maxLength: 20000 },
        waitMs: { type: "integer", minimum: 0, maximum: 600000 },
      },
      required: ["threadId", "text"],
      additionalProperties: false,
    },
    level: "change",
    approvalTitle: (args) => `Message another chat: “${(str(args, "text") ?? "").slice(0, 80)}”`,
    run: (deps, args) => {
      const id = threadPath(str(args, "threadId"));
      if (id === null) return Effect.fail(toolError("threadId is not a valid chat id."));
      const waitMs = num(args, "waitMs");
      return deps
        .bridge({
          method: "POST",
          path: `/api/threads/${id}/messages`,
          body: { text: str(args, "text"), ...(waitMs ? { waitMs } : {}) },
          timeoutMs: (waitMs ?? 0) + 30_000,
        })
        .pipe(Effect.flatMap(bridgeOk));
    },
  },
  {
    name: "chat_status",
    group: "chats",
    description:
      "Status and last messages of a chat. waitMs holds the call while it is running — use it to wait for a result instead of polling. Each message says who wrote it (you, assistant, human).",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        waitMs: { type: "integer", minimum: 0, maximum: 600000 },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) => {
      const id = threadPath(str(args, "threadId"));
      if (id === null) return Effect.fail(toolError("threadId is not a valid chat id."));
      const query = new URLSearchParams();
      if (num(args, "limit")) query.set("limit", String(num(args, "limit")));
      if (num(args, "waitMs")) query.set("waitMs", String(num(args, "waitMs")));
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return deps
        .bridge({
          method: "GET",
          path: `/api/threads/${id}${suffix}`,
          timeoutMs: (num(args, "waitMs") ?? 0) + 30_000,
        })
        .pipe(Effect.flatMap(bridgeOk));
    },
  },

  // The person
  {
    name: "notify",
    group: "person",
    description:
      "Tell the person something through Uno Work's Inbox (the bell; a system notification if they allowed it): a long task finished, something failed, you need them. Title in plain words starting with who/what. One per outcome, not per step. alsoMessenger also sends it to their Telegram/Slack when connected.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 140 },
        body: { type: "string", maxLength: 500 },
        level: { type: "string", enum: ["info", "warning", "error"], description: "Default info." },
        open: openTargetSchema,
        alsoMessenger: { type: "boolean" },
      },
      required: ["title"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      Effect.gen(function* () {
        const level = (str(args, "level") ?? "info") as "info" | "warning" | "error";
        const item = yield* deps.inboxPost({
          kind: level === "info" ? "agent.done" : "agent.error",
          source: {
            kind: "agent",
            id: deps.caller.threadId,
            name: deps.caller.threadTitle,
            icon: null,
          },
          title: str(args, "title")!,
          body: str(args, "body") ?? null,
          open: openTargetFrom(args.open, deps),
          groupKey: null,
        });
        const messenger = bool(args, "alsoMessenger")
          ? yield* deps.messengerNotify({
              text: [str(args, "title"), str(args, "body")].filter(Boolean).join("\n"),
              kind: level,
            })
          : null;
        return {
          ok: true,
          inboxItemId: item.id,
          ...(messenger ? { messengerDelivered: messenger.delivered } : {}),
        };
      }),
  },
  {
    name: "open_in_panel",
    group: "person",
    description:
      'Show something in the right panel of this chat: an app of this computer (appId — the easiest way to show an app you just made), a web page (a full url like "http://localhost:8124/"), or a local file. For a static result (report, HTML page, document) open the file — don\'t start a web server just to show it. scope: "chat" (default), "project" (all chats of this project) or "global" (only when the person asks).',
    inputSchema: {
      type: "object",
      properties: {
        appId: {
          type: "string",
          maxLength: 200,
          description: 'An app from apps_list, e.g. "notes" or "manifest:notes".',
        },
        path: {
          type: "string",
          maxLength: 2000,
          description: 'With appId: a page of the app, e.g. "/widget".',
        },
        url: {
          type: "string",
          maxLength: 8192,
          description: 'A complete http(s) address with host, e.g. "https://example.com/docs".',
        },
        file: {
          type: "string",
          description: "A file path (~/…, absolute, or relative to this chat's folder).",
        },
        scope: { type: "string", enum: ["chat", "project", "global"] },
      },
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      Effect.gen(function* () {
        const appId = str(args, "appId");
        const file = str(args, "file");
        let url = str(args, "url");
        if ([appId, url, file].filter((value) => value !== undefined).length !== 1) {
          return yield* toolError("Give exactly one of appId, url or file.");
        }
        if (appId !== undefined) {
          const app = yield* findApp(deps, appId);
          const base = app.publication?.url ?? app.url ?? app.localUrl;
          if (!base) {
            return yield* toolError(
              `${app.name} has no web address (status: ${app.status}). Start it or give it a port first.`,
            );
          }
          url = joinUrlPath(base, str(args, "path"));
        }
        if (url !== undefined && !isCompleteHttpUrl(url)) {
          return yield* toolError(
            `"${url}" is not a complete address. Pass the whole URL with host and port, e.g. "http://localhost:8124/", or use appId.`,
          );
        }
        const opened = yield* deps
          .bridge({
            method: "POST",
            path: "/api/browser/open",
            body: {
              ...(url !== undefined ? { url } : { file: resolveUserPath(file!, deps) }),
              ...(str(args, "scope") ? { scope: str(args, "scope") } : {}),
            },
          })
          .pipe(Effect.flatMap(bridgeOk));
        return url !== undefined ? { ok: true, opened: url } : opened;
      }),
  },
  {
    name: "browser_command",
    group: "person",
    description:
      "Drive the page open in this chat's right panel: state (URL, title, visible text), screenshot, click, clickText, type, press, navigate, reload, back, forward, evaluate. Prefer precise selectors/text; never print passwords or private fields. requestHelp (with `text`: what the person should do — sign in, captcha, 2FA code, a payment or a choice only they can make) hands the browser to the person and waits until they hand it back (default 10 min). On a new cloud computer the browser is set up on first use (~30–60 s): a reply saying it is being set up means do something else and retry after the given seconds.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          enum: [
            "state",
            "screenshot",
            "openUrl",
            "navigate",
            "click",
            "clickText",
            "type",
            "press",
            "reload",
            "back",
            "forward",
            "evaluate",
            "requestHelp",
          ],
        },
        url: {
          type: "string",
          description: 'For openUrl/navigate: a complete address, e.g. "http://localhost:3000/".',
        },
        selector: { type: "string", maxLength: 2000 },
        text: { type: "string", maxLength: 16000 },
        value: { type: "string", maxLength: 16000 },
        key: { type: "string", maxLength: 200 },
        script: { type: "string", maxLength: 32000 },
        fullPage: { type: "boolean" },
        // requestHelp waits for a person; the harness gives a tool call 15 min.
        timeoutMs: { type: "integer", minimum: 0, maximum: 840000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
    // requestHelp only asks the person — it is its own approval.
    level: (args) =>
      args.command === "state" || args.command === "screenshot" || args.command === "requestHelp"
        ? "safe"
        : "change",
    approvalTitle: (args) =>
      `Browser: ${str(args, "command")} ${str(args, "url") ?? str(args, "selector") ?? str(args, "text") ?? ""}`.trim(),
    run: (deps, args) =>
      deps
        .bridge({
          method: "POST",
          path: "/api/browser/command",
          body: args,
          timeoutMs:
            (num(args, "timeoutMs") ?? (args.command === "requestHelp" ? 600_000 : 30_000)) +
            10_000,
        })
        .pipe(
          Effect.flatMap(bridgeOk),
          Effect.map((result) => {
            const data = (result as { data?: { dataUrl?: unknown } } | null)?.data;
            const dataUrl = typeof data?.dataUrl === "string" ? data.dataUrl : null;
            const match = dataUrl ? /^data:(image\/[a-z]+);base64,(.*)$/s.exec(dataUrl) : null;
            if (!match) return result;
            const { dataUrl: _omit, ...meta } = data as Record<string, unknown>;
            return new McpContent([
              { type: "image", mimeType: match[1], data: match[2] },
              { type: "text", text: JSON.stringify({ ...(result as object), data: meta }) },
            ]);
          }),
        ),
  },
  {
    name: "request_secret",
    group: "person",
    description:
      "Ask the person for a secret (API key, token, password) through a masked field in Uno Work. The value is written to the project's .env (or .env.<x>) and never reaches you or the chat. Waits until they answer (up to 15 min). Use this instead of ever asking for a secret in chat.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
          maxLength: 128,
          description: "Env variable name, e.g. OPENAI_API_KEY.",
        },
        description: {
          type: "string",
          maxLength: 500,
          description: "What it is and where to get it — the person reads this.",
        },
        targetFile: { type: "string", pattern: "^\\.env(\\.[A-Za-z0-9_.-]+)?$" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      deps
        .bridge({
          method: "POST",
          path: "/api/secrets/request",
          body: {
            name: str(args, "name"),
            ...(str(args, "description") ? { description: str(args, "description") } : {}),
            ...(str(args, "targetFile") ? { targetFile: str(args, "targetFile") } : {}),
            ...(deps.caller.cwd ? { cwd: deps.caller.cwd } : {}),
          },
          timeoutMs: 16 * 60_000,
        })
        .pipe(Effect.flatMap(bridgeOk)),
  },

  // Sites
  {
    name: "site_publish",
    group: "sites",
    description:
      "Publish a static website from a folder (with index.html) or a single HTML file (published with its folder) to a public https address on Uno. Anyone can open it — the person always approves. Republishing the same slug updates the site.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          minLength: 1,
          description: "Folder or .html file, e.g. ~/projects/site/dist.",
        },
        slug: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,29}$",
          description: "Site name: lowercase letters, digits, dashes.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    level: "sensitive",
    approvalTitle: (args) => `Publish ${str(args, "path")} as a public website`,
    approvalDetail: (args) => (str(args, "slug") ? `Site name: ${str(args, "slug")}` : undefined),
    run: (deps, args) =>
      asToolError(
        deps.files.publishSite({
          path: resolveUserPath(str(args, "path")!, deps),
          ...(str(args, "slug") ? { slug: str(args, "slug")! } : {}),
        }),
      ),
  },

  // Account
  {
    name: "account_overview",
    group: "account",
    description:
      "The person's Uno account: plan and what it allows (biggest computer), the upgrade link, balances, and their computers (status, size, address). Read-only. Needs agent access Read only or Manage.",
    inputSchema: noArgs,
    level: "safe",
    run: (deps) =>
      Effect.gen(function* () {
        const settings = yield* asToolError(deps.settings);
        const access = accountAccess(settings);
        if (!access.linked) {
          return {
            linked: false,
            note: "Uno Work isn't signed in to an Uno account. The person can sign in from Settings.",
          };
        }
        if (access.level === "off") return yield* toolError(ACCESS_OFF_MESSAGE);
        const [cloud, plan] = yield* Effect.all(
          [deps.account.cloudState, deps.account.resizeOptions],
          {
            concurrency: "unbounded",
          },
        );
        return {
          linked: cloud.connected,
          ...(cloud.error ? { error: cloud.error } : {}),
          account: cloud.account
            ? {
                username: cloud.account.username,
                balanceUsd: cloud.account.balance,
                aiBalanceUsd: cloud.account.llmBalance,
              }
            : null,
          plan: {
            name: plan.planName,
            biggestComputer: plan.planMax,
            upgradeUrl: plan.upgradeUrl,
          },
          agentAccess: access.level,
          canCreateComputers: access.level === "manage",
          computers: cloud.boxes.map((box) => ({
            id: box.id,
            name: box.name,
            status: box.status,
            workComputer: box.workMachine ?? false,
            ramMb: box.ramMb,
            vcpu: box.vcpu,
            diskGb: box.diskGb,
            url: box.url ?? null,
          })),
        };
      }),
  },
  {
    name: "computer_create",
    group: "account",
    description:
      "Create a new Uno cloud computer with Uno Work on it (it appears in the person's computer switcher). Counts against their plan — the person always approves, and it only works when they set agent access to Manage. Returns a jobId for computer_create_status.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64 },
        ramMb: { type: "integer", minimum: 512, maximum: 262144 },
        vcpu: { type: "integer", minimum: 1, maximum: 64 },
        diskGb: { type: "integer", minimum: 5, maximum: 2000 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    level: "sensitive",
    approvalTitle: (args) => `Create a new Uno computer “${str(args, "name")}”`,
    approvalDetail: (args) =>
      [
        num(args, "ramMb") ? `${num(args, "ramMb")} MB RAM` : null,
        num(args, "vcpu") ? `${num(args, "vcpu")} vCPU` : null,
        num(args, "diskGb") ? `${num(args, "diskGb")} GB disk` : null,
      ]
        .filter(Boolean)
        .join(", ") || "Default size. It counts against your plan.",
    run: (deps, args) =>
      Effect.gen(function* () {
        const settings = yield* asToolError(deps.settings);
        const access = accountAccess(settings);
        if (!access.linked) {
          return yield* toolError("Uno Work isn't signed in to an Uno account.");
        }
        if (access.level !== "manage") {
          return yield* toolError(
            `Creating computers is off: the person's agent access is "${access.level}". Only they can switch it to Manage (Settings → Uno account → Agent access). Tell them; don't try another way.`,
          );
        }
        return yield* asToolError(
          deps.account.createBox({
            name: str(args, "name")!,
            ...(num(args, "ramMb") ? { ramMb: num(args, "ramMb")! } : {}),
            ...(num(args, "vcpu") ? { vcpu: num(args, "vcpu")! } : {}),
            ...(num(args, "diskGb") ? { diskGb: num(args, "diskGb")! } : {}),
            purpose: "work",
          }),
        );
      }),
  },
  {
    name: "computer_create_status",
    group: "account",
    description:
      "Progress of computer_create: creating → starting → waiting_daemon → ready (or failed).",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["jobId"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) => asToolError(deps.account.createBoxStatus({ jobId: str(args, "jobId")! })),
  },

  // Settings
  {
    name: "settings_read",
    group: "settings",
    description:
      "The Uno Work settings that shape what you may do: agent access to the Uno account, whether chats may start chats in other projects, which AI harnesses are enabled, the default AI for apps. Never includes keys.",
    inputSchema: noArgs,
    level: "safe",
    run: (deps) =>
      asToolError(deps.settings).pipe(
        Effect.map((settings) => {
          const access = accountAccess(settings);
          return {
            signedInToUno: access.linked,
            agentAccessToAccount: access.level,
            chatsMayStartChatsIn:
              settings.agentThreadsScope === "any-project" ? "any project" : "own project only",
            harnesses: Object.entries(settings.providerInstances)
              .filter(([, instance]) => instance.enabled !== false)
              .map(([id, instance]) => ({ id, driver: instance.driver })),
            thisChat: {
              mode: deps.caller.runtimeMode,
              meaning:
                deps.caller.runtimeMode === "approval-required"
                  ? "Ask mode: changes wait for the person's Allow."
                  : deps.caller.runtimeMode === "auto-accept-edits"
                    ? "Edits run freely; commands ask."
                    : "Full access: changes run without asking (sensitive tools still ask).",
            },
          };
        }),
      ),
  },

  // Docs
  {
    name: "uno_guide",
    group: "docs",
    description: `Detailed how-to for Uno Work, on demand. Topics: ${UNO_WORK_GUIDE_TOPICS.join(", ")}. Read "app-sdk" before building an app that uses AI, cloud files or notifications; "apps" / "widgets" for the manifest; "storage" for where app data goes.`,
    inputSchema: {
      type: "object",
      properties: { topic: { type: "string", enum: [...UNO_WORK_GUIDE_TOPICS] } },
      required: ["topic"],
      additionalProperties: false,
    },
    level: "safe",
    run: (deps, args) =>
      isUnoWorkGuideTopic(args.topic)
        ? Effect.succeed(buildUnoWorkGuide(args.topic, { pluginsDir: deps.pluginsDir }))
        : Effect.fail(toolError(`Unknown topic. Use one of: ${UNO_WORK_GUIDE_TOPICS.join(", ")}.`)),
  },
];

// ── Gate + MCP server ──────────────────────────────────────────────────

/**
 * Validate → gate → run. The approval card names the chat's own words
 * (`approvalTitle`); a refusal comes back as a tool error the model reads.
 */
export function runUnoWorkTool(
  tool: UnoWorkTool,
  deps: UnoWorkToolDeps,
  rawArgs: unknown,
): Effect.Effect<unknown, UnoWorkToolError> {
  return Effect.gen(function* () {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const problem = validateArgs(tool.inputSchema, args);
    if (problem !== null) {
      return yield* toolError(`Invalid arguments for ${tool.name}: ${problem}`);
    }
    const level = toolLevel(tool, args);
    if (decideUnoWorkGate(level, deps.caller.runtimeMode) === "ask") {
      // The person reads the app's name, not its id ("Stop Notes", not
      // "Stop manifest:notes").
      const appName =
        typeof args.appId === "string"
          ? yield* findApp(deps, args.appId).pipe(
              Effect.map((app) => `“${app.name}”`),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
      const described = appName ? { ...args, appId: appName } : args;
      const title = tool.approvalTitle?.(described) ?? tool.name;
      const detail = tool.approvalDetail?.(described);
      const outcome = yield* deps.requestApproval({
        tool: tool.name,
        title,
        ...(detail ? { detail } : {}),
        sensitive: level === "sensitive",
      });
      if (outcome !== "approved") {
        return yield* toolError(refusalMessage(outcome, title));
      }
    }
    return yield* tool.run(deps, args);
  });
}

const MCP_INSTRUCTIONS =
  "Tools for the Uno Work environment this chat runs in: this computer and its apps, widgets, files and cloud, other chats, the person's Inbox and right panel, sites, the Uno account and settings. Call uno_guide for details. Tools that change things may wait for the person's Allow; if they decline, don't retry or work around it.";

export const UNO_WORK_MCP_SERVER: McpServerDefinition<UnoWorkToolDeps, UnoWorkToolError> = {
  serverInfo: { name: UNO_WORK_MCP_SERVER_NAME, version: "1.0.0" },
  instructions: MCP_INSTRUCTIONS,
  tools: UNO_WORK_TOOLS.map((tool) => {
    const level = typeof tool.level === "function" ? null : tool.level;
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as unknown as Record<string, unknown>,
      annotations: {
        readOnlyHint: level === "safe",
        destructiveHint: level === "sensitive",
        openWorldHint: tool.group === "sites" || tool.group === "account",
      },
      run: (deps: UnoWorkToolDeps, args: unknown) => runUnoWorkTool(tool, deps, args),
    };
  }),
  errorText: (error) => error.message,
};
