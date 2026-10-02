/**
 * App servers: the person's bots and backends live on their own small
 * sleeping server on Uno — NOT on this computer. This computer is where the
 * agent works (and reads untrusted text all day); the app server is where the
 * customer-facing bot runs, with its token, on a separate network.
 *
 * The agent packs a project folder, uploads it, and the version waits for the
 * person's Allow in the Uno console (only a browser session can approve, roll
 * back or set the bot token — a confused or hijacked agent cannot). The
 * console never opens the archive; the app server downloads, checks and
 * builds it itself.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import type {
  UnoWorkTool,
  UnoWorkToolDeps,
  UnoWorkToolError,
} from "./tools.ts";

const execFileP = promisify(execFile);

type Deps = UnoWorkToolDeps;

/** What the tools need from tools.ts (passed in: no runtime import cycle). */
export interface AppServerToolKit {
  readonly callConsole: (
    deps: Deps,
    request: { method: "GET" | "POST" | "PUT"; path: string; body?: unknown },
    what: string,
  ) => Effect.Effect<Record<string, unknown>, UnoWorkToolError>;
  readonly resolvePath: (raw: string, deps: Deps) => string;
  readonly fail: (message: string) => UnoWorkToolError;
}

export const APP_SERVER_GUIDE = [
  "Bots and backends go on an app server, never on this computer and never in the right panel.",
  "A Telegram bot must use a webhook, not polling: listen on $PORT (8080), handle POST /telegram,",
  "check the header X-Telegram-Bot-Api-Secret-Token equals $UNO_TELEGRAM_SECRET, read the token from",
  "$TELEGRAM_BOT_TOKEN. Uno sets the webhook itself once the person adds the token in the console.",
  "Keep data that must survive updates in $UNO_DATA_DIR. Python: requirements.txt + main.py/bot.py/app.py;",
  "Node: package.json with a start script; or pass startCmd. Tests must never write into the real data.",
].join(" ");

const NAME_PATTERN = "^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$";

interface Packed {
  readonly file: string;
  readonly dir: string;
  readonly sha256: string;
  readonly size: number;
}

const EXCLUDES = [
  "./.git",
  "./node_modules",
  "./.venv",
  "./venv",
  "./__pycache__",
  "*.pyc",
  "./.env",
  "./.env.*",
  "./.uno",
  "./.DS_Store",
];

async function packProject(dir: string): Promise<Packed> {
  const stat = await fsp.stat(dir);
  if (!stat.isDirectory()) throw new Error(`${dir} is not a folder`);
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "uno-app-"));
  const file = path.join(tmp, "app.tar.gz");
  await execFileP("tar", [
    "-czf",
    file,
    ...EXCLUDES.map((e) => `--exclude=${e}`),
    "-C",
    dir,
    ".",
  ]);
  const data = await fsp.readFile(file);
  return {
    file,
    dir: tmp,
    sha256: createHash("sha256").update(data).digest("hex"),
    size: data.byteLength,
  };
}

async function putArtifact(
  url: string,
  file: string,
  size: number,
): Promise<void> {
  const body = await fsp.readFile(file);
  const res = await fetch(url, {
    method: "PUT",
    body,
    headers: { "content-length": String(size) },
    signal: AbortSignal.timeout(5 * 60_000),
  });
  if (!res.ok) throw new Error(`upload failed: HTTP ${res.status}`);
}

const compactServer = (raw: unknown) => {
  const s = (raw ?? {}) as Record<string, unknown>;
  const live = (s.live ?? null) as Record<string, unknown> | null;
  const pending = (s.pending ?? null) as Record<string, unknown> | null;
  return {
    id: s.id,
    name: s.name,
    state: s.state,
    url: s.url ?? null,
    liveVersion: live?.version ?? null,
    pendingVersion: pending
      ? { version: pending.version, status: pending.status }
      : null,
  };
};

export function appServerTools(
  kit: AppServerToolKit,
): ReadonlyArray<UnoWorkTool> {
  const findServer = (deps: Deps, name: string) =>
    kit
      .callConsole(
        deps,
        { method: "GET", path: "/api/v1/app-servers" },
        "list the app servers",
      )
      .pipe(
        Effect.map((body) => {
          const servers = Array.isArray(body.servers) ? body.servers : [];
          return servers.find(
            (s) => (s as Record<string, unknown>).name === name,
          ) as Record<string, unknown> | undefined;
        }),
      );

  return [
    {
      name: "app_servers_list",
      group: "apps",
      description:
        "The person's app servers on Uno — small sleeping servers where bots and backends run, separate from this computer: name, state (sleeping/working/out_of_hours), https address, live and pending version, and this month's hours. " +
        APP_SERVER_GUIDE,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      level: "safe",
      run: (deps: Deps) =>
        kit
          .callConsole(
            deps,
            { method: "GET", path: "/api/v1/app-servers" },
            "list the app servers",
          )
          .pipe(
            Effect.map((body) => ({
              enabled: body.enabled,
              hoursUsed: body.used_hours,
              limits: body.limits,
              outOfHours: body.out_of_hours,
              servers: (Array.isArray(body.servers) ? body.servers : []).map(
                compactServer,
              ),
            })),
          ),
    },
    {
      name: "app_deploy",
      group: "apps",
      description:
        "Put a project folder on an app server (created if it does not exist): packs the folder (without .env, .git, node_modules, .venv), uploads it, and the version waits for the person's Allow in the Uno console — tell them to press Allow there. Then the server builds and runs it and stays reachable at its https address, waking on each request. " +
        APP_SERVER_GUIDE,
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description: "Project folder, e.g. ~/projects/cafe-bot.",
          },
          server: {
            type: "string",
            pattern: NAME_PATTERN,
            description:
              "App server name (3–32 lowercase letters, digits, dashes), e.g. cafe-bot.",
          },
          startCmd: {
            type: "string",
            description:
              "Optional start command, e.g. .venv/bin/python bot.py.",
          },
          note: {
            type: "string",
            description: "What changed in this version, one line.",
          },
        },
        required: ["path", "server"],
        additionalProperties: false,
      },
      level: "change",
      approvalTitle: (args: Record<string, unknown>) =>
        `Send ${String(args.path)} to the app server “${String(args.server)}”`,
      approvalDetail: () =>
        "It goes live only after you press Allow in the Uno console.",
      run: (deps: Deps, args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const name = String(args.server);
          const dir = kit.resolvePath(String(args.path), deps);
          let server = yield* findServer(deps, name);
          let created = false;
          if (!server) {
            server = yield* kit.callConsole(
              deps,
              { method: "POST", path: "/api/v1/app-servers", body: { name } },
              "create the app server",
            );
            created = true;
          }
          const id = Number(server.id);
          const packed = yield* Effect.tryPromise({
            try: () => packProject(dir),
            catch: (e) =>
              kit.fail(`could not pack ${dir}: ${(e as Error).message}`),
          });
          try {
            if (packed.size > 50 * 1024 * 1024) {
              return yield* kit.fail(
                "the project is larger than 50 MB packed; leave out data and build output",
              );
            }
            const started = yield* kit.callConsole(
              deps,
              {
                method: "POST",
                path: `/api/v1/app-servers/${id}/deploys`,
                body: {
                  sha256: packed.sha256,
                  size_bytes: packed.size,
                  ...(typeof args.startCmd === "string"
                    ? { start_cmd: args.startCmd }
                    : {}),
                  ...(typeof args.note === "string" ? { note: args.note } : {}),
                },
              },
              "start a new version",
            );
            const deploy = (started.deploy ?? {}) as Record<string, unknown>;
            yield* Effect.tryPromise({
              try: () =>
                putArtifact(
                  String(started.upload_url),
                  packed.file,
                  packed.size,
                ),
              catch: (e) => kit.fail((e as Error).message),
            });
            const done = yield* kit.callConsole(
              deps,
              {
                method: "POST",
                path: `/api/v1/app-servers/${id}/deploys/${String(deploy.id)}/uploaded`,
              },
              "finish the upload",
            );
            const d = (done.deploy ?? deploy) as Record<string, unknown>;
            return {
              server: { id, name, url: server.url ?? null, created },
              version: d.version,
              status: d.status,
              next:
                d.status === "pending_approval"
                  ? "Ask the person to press Allow for this version in the Uno console (App servers). Bot tokens are added there too — never ask for them in the chat."
                  : "It is going live now; check app_servers_list in a minute.",
            };
          } finally {
            yield* Effect.promise(() =>
              fsp.rm(packed.dir, { recursive: true, force: true }),
            );
          }
        }),
    },
    {
      name: "app_server_logs",
      group: "apps",
      description:
        "The last lines of an app server's log (wakes it for a moment). Use it to see why a bot does not answer.",
      inputSchema: {
        type: "object",
        properties: {
          server: {
            type: "string",
            pattern: NAME_PATTERN,
            description: "App server name.",
          },
          lines: { type: "integer", minimum: 1, maximum: 1000 },
        },
        required: ["server"],
        additionalProperties: false,
      },
      level: "safe",
      run: (deps: Deps, args: Record<string, unknown>) =>
        Effect.gen(function* () {
          const server = yield* findServer(deps, String(args.server));
          if (!server)
            return yield* kit.fail(
              `no app server named ${String(args.server)}`,
            );
          const n = typeof args.lines === "number" ? args.lines : 200;
          const body = yield* kit.callConsole(
            deps,
            {
              method: "GET",
              path: `/api/v1/app-servers/${String(server.id)}/logs?lines=${n}`,
            },
            "read the app log",
          );
          return { logs: body.logs };
        }),
    },
  ];
}
