/**
 * `spark_*` tools: one JavaScript or Python file (or a small folder) answers
 * HTTPS at `https://<name>.spark.uno4.me/` — no server, free. The daemon
 * talks to the Spark gateway with a Spark-only token it gets from the console
 * itself (`sparkClient.ts`); the agent never sees a token.
 *
 * Secrets: the agent names a variable of the project's `.env`; the daemon
 * reads the value and hands it to Spark for the listed hosts only. The value
 * never goes into a tool result, the chat or a log line.
 *
 * Misha's walk 18.10: asked to "deploy my project to uno.place", the agent
 * didn't know Spark and said "there is no server, order Small".
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { describeSiteSkips } from "../files/sitePublish.ts";
import { registerKnownSecret } from "../secretRedaction.ts";
import {
  SPARK_MAX_BYTES,
  SPARK_NAME_PATTERN,
  SPARK_NOT_LINKED_MESSAGE,
  errorParts,
  guessSparkEntry,
  packSparkFolder,
  readEnvValue,
  sparkAppUrl,
  sparkTypeOf,
  type SparkReply,
  type SparkRequest,
  type SparkType,
} from "./sparkClient.ts";
import type { UnoWorkTool, UnoWorkToolDeps, UnoWorkToolError } from "./tools.ts";

type Deps = UnoWorkToolDeps;

/** What the tools need from tools.ts (passed in: no runtime import cycle). */
export interface SparkToolKit {
  readonly resolvePath: (raw: string, deps: Deps) => string;
  readonly displayPath: (absolute: string, home: string) => string;
  readonly fail: (message: string) => UnoWorkToolError;
}

/** The longest compiler text handed back whole. */
const COMPILER_TEXT_MAX = 12_000;
const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,63}$";
const HOST_PATTERN = "^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$";

const nameArg = {
  type: "string" as const,
  pattern: SPARK_NAME_PATTERN,
  description:
    "The app's name: 3–32 lowercase letters, digits and dashes, starting with a letter. It becomes https://<name>.spark.uno4.me/.",
};

export const SPARK_LIMITS_LINE =
  "Inside: env.KV (get/put/delete/list/incr, shared by the account's apps), fetch to public addresses, variables and secrets. Not there: files, SQL databases, AI calls, packages, timers or cron (it only answers requests). Limits: Free 3 apps (paid plans 20), a few ms of CPU per call, a call ends after 10 s, a fetch waits 5 s, about 120 requests a minute per account.";

const sparkUnavailable = (kit: SparkToolKit) => kit.fail(SPARK_NOT_LINKED_MESSAGE);

const callSpark = (
  kit: SparkToolKit,
  deps: Deps,
  request: SparkRequest,
): Effect.Effect<SparkReply, UnoWorkToolError> =>
  deps.spark ? deps.spark.request(request) : Effect.fail(sparkUnavailable(kit));

/** A gateway answer that isn't 2xx, as a sentence the agent can act on. */
export function sparkReplyMessage(
  reply: SparkReply,
  input: { readonly name?: string; readonly what: string; readonly deploying?: boolean },
): string {
  const { code, detail } = errorParts(reply.status, reply.text);
  const lower = code.toLowerCase();
  const name = input.name ?? "";
  if (input.deploying && reply.status === 400 && lower !== "invalid_name") {
    const text = reply.text.trim();
    const body =
      text.length > COMPILER_TEXT_MAX ? `${text.slice(0, COMPILER_TEXT_MAX)}\n…(cut)` : text;
    return `Spark didn't accept the code of “${name}”. What it said:\n${body}\nFix the code and deploy again.`;
  }
  if (reply.status === 401) {
    return "Spark didn't accept this computer's Spark access, even a fresh one. Tell the person in one line; don't try another way.";
  }
  if (lower === "account_not_claimed") {
    return "This Uno account isn't claimed yet, and Spark needs a claimed account. Tell the person to finish setting up their account in the Uno console (console.uno.place), then try again.";
  }
  if (lower === "spark_unavailable" || lower === "spark_off") {
    return "Spark isn't switched on for this Uno account yet. Tell the person in one line; meanwhile run it as an app on this computer (uno_guide apps) or on an app server (uno_guide app-servers).";
  }
  if (lower === "name_taken") {
    return `The name “${name}” belongs to another Uno account. Pick another name and deploy again.`;
  }
  if (reply.status === 404) {
    return `There is no Spark app “${name}” on this account (spark_list shows them).`;
  }
  if (reply.status === 409) {
    return `Spark refused to ${input.what}: ${detail || code}. If the account is at its app limit (Free 3, paid plans 20), spark_list shows the apps: ask the person which one to delete (spark_delete), or offer an upgrade.`;
  }
  if (reply.status === 413) {
    return "This is too big for Spark: it takes a small program. Leave out data and packages.";
  }
  if (reply.status === 429 || reply.sparkError === "rate_limited") {
    return "Spark is rate limiting this account (about 120 requests a minute). Wait a minute and try again.";
  }
  return `Spark couldn't ${input.what}: ${[code, detail].filter(Boolean).join(" — ") || `HTTP ${reply.status}`}.`;
}

const ok = (reply: SparkReply) => reply.status >= 200 && reply.status < 300;

const ensureOk = (
  kit: SparkToolKit,
  reply: SparkReply,
  input: Parameters<typeof sparkReplyMessage>[1],
): Effect.Effect<SparkReply, UnoWorkToolError> =>
  ok(reply) ? Effect.succeed(reply) : Effect.fail(kit.fail(sparkReplyMessage(reply, input)));

const appPath = (name: string, rest = "") => `/apps/${encodeURIComponent(name)}${rest}`;

interface SecretArg {
  readonly name: string;
  readonly fromEnv?: string;
  readonly hosts: ReadonlyArray<string>;
}

interface EnvArg {
  readonly name: string;
  readonly value: string;
}

const records = <T>(args: Record<string, unknown>, key: string): T[] =>
  Array.isArray(args[key]) ? (args[key] as T[]) : [];

/** What the project folder's `.env` (then the chat folder's) says for `name`. */
async function projectEnvValue(folders: ReadonlyArray<string>, name: string) {
  for (const folder of folders) {
    const text = await fsp.readFile(path.join(folder, ".env"), "utf8").catch(() => null);
    if (text === null) continue;
    const value = readEnvValue(text, name);
    if (value !== null) return value;
  }
  return null;
}

function insideHome(target: string, home: string): boolean {
  const relative = path.relative(home, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return !relative.split(path.sep).some((part) => part.startsWith("."));
}

const TELEGRAM_HOST = "api.telegram.org";

export function sparkTools(kit: SparkToolKit): ReadonlyArray<UnoWorkTool> {
  return [
    {
      name: "spark_deploy",
      group: "sites",
      description:
        "Put one JavaScript or Python file (or a small folder with an entry file) on Uno Spark: it answers HTTPS at https://<name>.spark.uno4.me/ right away — no server, free, nothing to keep running. Use it for webhooks, Telegram bots, small JSON APIs and form handlers; a frontend goes on Sites (site_publish). JS: `export default { async fetch(request, env) { return Response.json({...}) } }`; Python: `import spark` + `def fetch(request, env): return spark.Response.json({...})`. " +
        SPARK_LIMITS_LINE +
        " Anything that needs more (a timer, AI answers longer than 10 s, a SQL database, packages) is not Spark: read uno_guide spark first if unsure. Redeploying the same name makes a new version. `env` sets plain variables (replaces all; never tokens); `secrets` hands a value from the project's .env to Spark for the listed hosts only — you never see it, and it never goes into the result. Runs without asking, like a site; spark_delete takes it down.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            minLength: 1,
            description:
              "A .js/.py file, or a folder (packed without .env, keys, .git, node_modules), e.g. ~/projects/bot/bot.js.",
          },
          name: nameArg,
          type: {
            type: "string",
            enum: ["js", "python"],
            description: "js or python; by default from the file's extension.",
          },
          entry: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            description:
              "For a folder: the file with fetch(), relative to it (default index.js / main.py / app.py / bot.py).",
          },
          env: {
            type: "array",
            maxItems: 50,
            description:
              "Plain variables the app reads as env.NAME (replaces the app's variables). Never put tokens or passwords here: use secrets.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", pattern: ENV_NAME_PATTERN },
                value: { type: "string", maxLength: 4096 },
              },
              required: ["name", "value"],
              additionalProperties: false,
            },
          },
          secrets: {
            type: "array",
            maxItems: 20,
            description:
              "Secrets the app may use only in a fetch to the listed hosts (in the URL or a header as env.NAME). The value is read by Uno Work from the project's .env — put it there with request_secret first.",
            items: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                  pattern: ENV_NAME_PATTERN,
                  description: "The name the app sees, e.g. TELEGRAM_BOT_TOKEN.",
                },
                fromEnv: {
                  type: "string",
                  pattern: ENV_NAME_PATTERN,
                  description:
                    "The variable in the project's .env holding the value (default: the same name).",
                },
                hosts: {
                  type: "array",
                  maxItems: 10,
                  description: 'Where it may be sent, e.g. ["api.telegram.org"].',
                  items: { type: "string", pattern: HOST_PATTERN },
                },
              },
              required: ["name", "hosts"],
              additionalProperties: false,
            },
          },
        },
        required: ["path", "name"],
        additionalProperties: false,
      },
      // Like site_publish (decision 02.10): free, and spark_delete takes it down.
      level: "safe",
      run: (deps, args) =>
        Effect.gen(function* () {
          if (!deps.spark) return yield* sparkUnavailable(kit);
          const name = String(args.name);
          const target = kit.resolvePath(String(args.path), deps);
          if (!insideHome(target, deps.home)) {
            return yield* kit.fail(
              "Deploy a file or a folder inside the home folder (not a hidden one), e.g. ~/projects/<name>.",
            );
          }
          const stat = yield* Effect.tryPromise({
            try: () => fsp.stat(target),
            catch: () => kit.fail(`${kit.displayPath(target, deps.home)} doesn't exist.`),
          });
          const argType = typeof args.type === "string" ? (args.type as SparkType) : undefined;

          let type: SparkType;
          let query: string;
          let body: Uint8Array;
          let contentType: string;
          let skipped: string | null = null;
          const folder = stat.isDirectory() ? target : path.dirname(target);
          if (stat.isDirectory()) {
            const packed = yield* Effect.tryPromise({
              try: () => packSparkFolder(target),
              catch: (cause) => kit.fail(cause instanceof Error ? cause.message : String(cause)),
            });
            const entry =
              typeof args.entry === "string"
                ? args.entry.replace(/^\.\//, "")
                : guessSparkEntry(packed.files, argType);
            if (entry === null) {
              return yield* kit.fail(
                "Pass entry: the file with fetch() in this folder, e.g. index.js or main.py.",
              );
            }
            if (!packed.files.includes(entry)) {
              return yield* kit.fail(
                `${entry} isn't in this folder (or stays behind: hidden files, keys, node_modules and links are never packed).`,
              );
            }
            const entryType = argType ?? sparkTypeOf(entry);
            if (entryType === null) {
              return yield* kit.fail(
                "Spark runs JavaScript (.js) or Python (.py). Compile TypeScript to one .js first.",
              );
            }
            type = entryType;
            query = `?type=${type}&entry=${encodeURIComponent(entry)}`;
            body = packed.bytes;
            contentType = "application/gzip";
            if (packed.skipped.length > 0) skipped = describeSiteSkips(packed.skipped);
          } else {
            const fileType = argType ?? sparkTypeOf(target);
            if (fileType === null) {
              return yield* kit.fail(
                "Spark runs one JavaScript (.js) or Python (.py) file. Compile TypeScript to one .js first; a page or a frontend goes on Sites (site_publish).",
              );
            }
            if (stat.size > SPARK_MAX_BYTES) {
              return yield* kit.fail("This file is bigger than 10 MB — too big for Spark.");
            }
            type = fileType;
            query = `?type=${type}`;
            body = new Uint8Array(
              yield* Effect.tryPromise({
                try: () => fsp.readFile(target),
                catch: () => kit.fail(`Couldn't read ${kit.displayPath(target, deps.home)}.`),
              }),
            );
            contentType = type === "js" ? "application/javascript" : "text/x-python";
          }

          // Secrets are read before anything goes up: a missing one stops here.
          const envVars = records<EnvArg>(args, "env");
          const secretArgs = records<SecretArg>(args, "secrets");
          const searchIn = [folder, ...(deps.caller.cwd ? [deps.caller.cwd] : [])];
          const secrets: Array<{ name: string; from: string; hosts: string[]; value: string }> = [];
          for (const secret of secretArgs) {
            if (secret.hosts.length === 0) {
              return yield* kit.fail(
                `Secret ${secret.name} needs hosts: where the app may send it, e.g. ["api.telegram.org"].`,
              );
            }
            if (envVars.some((entry) => entry.name === secret.name)) {
              return yield* kit.fail(`${secret.name} is both a variable and a secret: keep one.`);
            }
            const from = secret.fromEnv ?? secret.name;
            const value = yield* Effect.promise(() => projectEnvValue(searchIn, from));
            if (value === null) {
              return yield* kit.fail(
                `${from} isn't in the project's .env (${kit.displayPath(path.join(folder, ".env"), deps.home)}). Ask the person for it with request_secret (name ${from}, in this folder), then deploy again.`,
              );
            }
            registerKnownSecret(value);
            secrets.push({ name: secret.name, from, hosts: [...secret.hosts], value });
          }

          const deployed = yield* callSpark(kit, deps, {
            method: "PUT",
            path: `${appPath(name)}${query}`,
            body,
            contentType,
          }).pipe(
            Effect.flatMap((reply) =>
              ensureOk(kit, reply, { name, what: "deploy it", deploying: true }),
            ),
          );
          const answer = (deployed.json ?? {}) as Record<string, unknown>;
          const app = (
            typeof answer.app === "object" && answer.app !== null ? answer.app : answer
          ) as Record<string, unknown>;

          if (envVars.length > 0) {
            yield* callSpark(kit, deps, {
              method: "PUT",
              path: appPath(name, "/env"),
              json: Object.fromEntries(envVars.map((entry) => [entry.name, entry.value])),
            }).pipe(
              Effect.flatMap((reply) => ensureOk(kit, reply, { name, what: "set its variables" })),
            );
          }
          for (const secret of secrets) {
            yield* callSpark(kit, deps, {
              method: "PUT",
              path: appPath(name, `/secrets/${encodeURIComponent(secret.name)}`),
              json: { value: secret.value, hosts: secret.hosts },
            }).pipe(
              Effect.flatMap((reply) =>
                ensureOk(kit, reply, { name, what: `set the secret ${secret.name}` }),
              ),
            );
          }

          const url = sparkAppUrl(name, app.url);
          const telegram = secrets.find((secret) => secret.hosts.includes(TELEGRAM_HOST));
          const notes = [
            `Live at ${url} — free; it runs only when called (no timers). spark_logs shows what it printed; deploying the same name again makes a new version.`,
            ...(telegram
              ? [
                  `Telegram: point the bot's webhook here once, from the project folder, without printing the token: set -a; . ./.env; set +a; curl -s "https://api.telegram.org/bot$${telegram.from}/setWebhook?url=${url}"`,
                ]
              : []),
            ...(skipped
              ? [
                  `Left on this computer (not packed): ${skipped}. Don't offer a way to pack a key or secret file.`,
                ]
              : []),
          ];
          return {
            name,
            url,
            type,
            status: deployed.status === 201 ? "created" : "updated",
            ...(app.version !== undefined ? { version: app.version } : {}),
            ...(envVars.length > 0 ? { env: envVars.map((entry) => entry.name) } : {}),
            ...(secrets.length > 0
              ? { secrets: secrets.map((secret) => ({ name: secret.name, hosts: secret.hosts })) }
              : {}),
            note: notes.join(" "),
          };
        }),
    },
    {
      name: "spark_list",
      group: "sites",
      description:
        "The person's Spark apps (name, address, version) and the account's Spark limits (plan, apps used of how many). Use it before spark_delete or when a deploy says the limit is reached.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      level: "safe",
      run: (deps) =>
        Effect.gen(function* () {
          const apps = yield* callSpark(kit, deps, { method: "GET", path: "/apps" }).pipe(
            Effect.flatMap((reply) => ensureOk(kit, reply, { what: "list the apps" })),
          );
          const whoami = yield* callSpark(kit, deps, { method: "GET", path: "/whoami" }).pipe(
            Effect.map((reply) => (ok(reply) ? reply.json : null)),
            Effect.orElseSucceed(() => null),
          );
          const json = apps.json as Record<string, unknown> | unknown[] | null;
          const list = Array.isArray(json)
            ? json
            : Array.isArray(json?.apps)
              ? json.apps
              : Array.isArray(json?.sparks)
                ? json.sparks
                : [];
          return {
            apps: (list as Array<Record<string, unknown>>).map((entry) => {
              const name = typeof entry.name === "string" ? entry.name : String(entry.slug ?? "");
              // The gateway's freshly parsed JSON: filled in place.
              return Object.assign(entry, { name, url: sparkAppUrl(name, entry.url) });
            }),
            account: whoami,
          };
        }),
    },
    {
      name: "spark_logs",
      group: "sites",
      description:
        "What a Spark app printed and a line per request (status, errors such as cpu_limit or wall_limit). Use it when a Spark app doesn't answer as expected.",
      inputSchema: {
        type: "object",
        properties: {
          name: nameArg,
          n: { type: "integer", minimum: 1, maximum: 1000, description: "Lines (default 200)." },
        },
        required: ["name"],
        additionalProperties: false,
      },
      level: "safe",
      run: (deps, args) => {
        const name = String(args.name);
        const n = typeof args.n === "number" ? args.n : 200;
        return callSpark(kit, deps, { method: "GET", path: appPath(name, `/logs?n=${n}`) }).pipe(
          Effect.flatMap((reply) => ensureOk(kit, reply, { name, what: "read its log" })),
          Effect.map((reply) => ({ name, logs: reply.json ?? reply.text })),
        );
      },
    },
    {
      name: "spark_delete",
      group: "sites",
      description:
        "Delete a Spark app: its address stops working, its variables and secrets go, and the name is freed (the code on this computer stays; spark_deploy puts it back). Use it when the person asks, or to free a slot with their OK. The person always approves.",
      inputSchema: {
        type: "object",
        properties: { name: nameArg },
        required: ["name"],
        additionalProperties: false,
      },
      level: "sensitive",
      approvalTitle: (args) => `Delete the Spark app ${sparkAppUrl(String(args.name ?? ""))}`,
      approvalDetail: () =>
        "The address stops working for everyone and the name is freed. The code on your computer stays.",
      run: (deps, args) => {
        const name = String(args.name);
        return callSpark(kit, deps, { method: "DELETE", path: appPath(name) }).pipe(
          Effect.flatMap((reply) => ensureOk(kit, reply, { name, what: "delete it" })),
          Effect.map(() => ({
            ok: true,
            name,
            note: `${sparkAppUrl(name)} is gone and the name is free. The code on this computer is untouched.`,
          })),
        );
      },
    },
  ];
}
