import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import type { ServerSettings } from "@t3tools/contracts";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  SPARK_API_BASE,
  makeSparkClient,
  memorySparkTokenCache,
  readEnvValue,
  type SparkTokenCache,
} from "./sparkClient.ts";
import {
  UNO_WORK_TOOLS,
  UnoWorkToolError,
  runUnoWorkTool,
  toolLevel,
  type UnoWorkToolDeps,
} from "./tools.ts";

const CONSOLE = "https://console.test";
const SECRET_VALUE = "123456:AAH-very-secret-bot-token";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  readonly contentType: string | null;
  readonly body: Uint8Array | string | null;
}

type Responder = (call: Call) => {
  status: number;
  body?: string;
  headers?: Record<string, string>;
};

/** A fetch that records every call and answers from `respond` (mints count separately). */
function fakeFetch(respond: Responder) {
  const calls: Call[] = [];
  let minted = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      contentType: headers.get("content-type"),
      body:
        raw === undefined || raw === null
          ? null
          : typeof raw === "string"
            ? raw
            : new Uint8Array(raw as Uint8Array),
    };
    calls.push(call);
    if (url === `${CONSOLE}/api/v1/spark/token`) {
      minted += 1;
      const reply = respond(call);
      if (reply.status !== 0) {
        return new Response(reply.body ?? "", { status: reply.status });
      }
      return new Response(
        JSON.stringify({
          token: `uno_spark_${minted}`,
          expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
          api: SPARK_API_BASE,
        }),
        { status: 201 },
      );
    }
    const reply = respond(call);
    return new Response(reply.body ?? "", {
      status: reply.status,
      ...(reply.headers ? { headers: reply.headers } : {}),
    });
  }) as typeof fetch;
  return { calls, fetchImpl, minted: () => minted };
}

/** Mint answers with status 0 = "issue a token". */
const gatewayOk: Responder = (call) =>
  call.url.endsWith("/spark/token")
    ? { status: 0 }
    : call.method === "PUT" && /\/apps\/[^/?]+\?/.test(call.url)
      ? { status: 201, body: JSON.stringify({ name: "cafe-bot", version: 1 }) }
      : { status: 200, body: "{}" };

function makeDeps(options: {
  respond?: Responder;
  credential?: string;
  cache?: SparkTokenCache;
  approval?: "approved" | "denied";
  noSpark?: boolean;
}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "uno-spark-"));
  tempDirs.push(home);
  const project = path.join(home, "projects", "cafe-bot");
  mkdirSync(project, { recursive: true });
  const fake = fakeFetch(options.respond ?? gatewayOk);
  const client = makeSparkClient({
    credential: async () => options.credential ?? "uno_agt_machine",
    consoleBaseUrl: CONSOLE,
    cache: options.cache ?? memorySparkTokenCache(),
    fetchImpl: fake.fetchImpl,
  });
  const approvals: string[] = [];
  const deps = {
    caller: {
      threadId: "thread-1",
      threadTitle: "Bot",
      runtimeMode: "full-access",
      cwd: project,
    },
    home,
    manifestDir: path.join(home, ".uno", "apps"),
    pluginsDir: path.join(home, ".t3", "plugins"),
    settings: Effect.succeed({ uno: { apiKey: "unollm_x" } } as unknown as ServerSettings),
    requestApproval: (input: { title: string }) =>
      Effect.sync(() => {
        approvals.push(input.title);
        return options.approval ?? "approved";
      }),
    ...(options.noSpark
      ? {}
      : {
          spark: {
            request: (request: Parameters<typeof client.request>[0]) =>
              Effect.tryPromise({
                try: () => client.request(request),
                catch: (cause) =>
                  new UnoWorkToolError({
                    message: cause instanceof Error ? cause.message : String(cause),
                  }),
              }),
          },
        }),
  } as unknown as UnoWorkToolDeps;
  return { deps, home, project, fake, approvals };
}

const tool = (name: string) => {
  const found = UNO_WORK_TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

async function run(name: string, deps: UnoWorkToolDeps, args: unknown) {
  return Effect.runPromise(Effect.result(runUnoWorkTool(tool(name), deps, args)));
}

function okValue(result: Awaited<ReturnType<typeof run>>): Record<string, unknown> {
  if (result._tag !== "Success") throw new Error(`failed: ${String(result.failure.message)}`);
  return result.success as Record<string, unknown>;
}

function failMessage(result: Awaited<ReturnType<typeof run>>): string {
  if (result._tag !== "Failure") throw new Error("expected a failure");
  return result.failure.message;
}

/** File names inside a ustar .tar.gz. */
function tarNames(gz: Uint8Array): string[] {
  const tar = gunzipSync(gz);
  const names: string[] = [];
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0", 1)[0]!;
    const name = field(0, 100);
    const prefix = field(345, 155);
    const size = Number.parseInt(field(124, 12), 8);
    names.push(prefix ? `${prefix}/${name}` : name);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

const gatewayCalls = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.url.startsWith(SPARK_API_BASE));

describe("spark tools: levels", () => {
  it("deploy runs like a site, reads are safe, delete always asks", () => {
    expect(toolLevel(tool("spark_deploy"), {})).toBe("safe");
    expect(toolLevel(tool("spark_list"), {})).toBe("safe");
    expect(toolLevel(tool("spark_logs"), {})).toBe("safe");
    expect(toolLevel(tool("spark_delete"), {})).toBe("sensitive");
  });
});

describe("spark_deploy", () => {
  it("mints a Spark token with this computer's credential and puts one file up", async () => {
    const { deps, project, fake } = makeDeps({});
    writeFileSync(path.join(project, "bot.js"), "export default { fetch() {} }");
    const result = okValue(
      await run("spark_deploy", deps, { path: "~/projects/cafe-bot/bot.js", name: "cafe-bot" }),
    );
    const mint = fake.calls[0]!;
    expect(mint.url).toBe(`${CONSOLE}/api/v1/spark/token`);
    expect(mint.method).toBe("POST");
    expect(mint.auth).toBe("Bearer uno_agt_machine");
    const put = gatewayCalls(fake.calls)[0]!;
    expect(put.method).toBe("PUT");
    expect(put.url).toBe(`${SPARK_API_BASE}/apps/cafe-bot?type=js`);
    expect(put.auth).toBe("Bearer uno_spark_1");
    expect(Buffer.from(put.body as Uint8Array).toString()).toBe("export default { fetch() {} }");
    expect(result).toMatchObject({
      name: "cafe-bot",
      url: "https://cafe-bot.spark.uno4.me/",
      type: "js",
      status: "created",
      version: 1,
    });
    expect(JSON.stringify(result)).not.toContain("uno_spark_");
  });

  it("keeps the token between calls and mints again for another credential", async () => {
    const cache = memorySparkTokenCache();
    const first = makeDeps({ cache });
    writeFileSync(path.join(first.project, "app.py"), "import spark\n");
    okValue(await run("spark_deploy", first.deps, { path: "app.py", name: "cafe-bot" }));
    okValue(await run("spark_list", first.deps, {}));
    expect(first.fake.minted()).toBe(1);
    expect(gatewayCalls(first.fake.calls)[0]!.url).toContain("?type=python");

    const other = makeDeps({ cache, credential: "uno_usr_other_account" });
    okValue(await run("spark_list", other.deps, {}));
    expect(other.fake.minted()).toBe(1);
  });

  it("a 401 from the gateway mints a new token once and retries", async () => {
    let puts = 0;
    const { deps, project, fake } = makeDeps({
      respond: (call) => {
        if (call.url.endsWith("/spark/token")) return { status: 0 };
        puts += 1;
        return puts === 1 ? { status: 401, body: "{}" } : { status: 200, body: "{}" };
      },
    });
    writeFileSync(path.join(project, "bot.js"), "x");
    const result = okValue(await run("spark_deploy", deps, { path: "bot.js", name: "cafe-bot" }));
    expect(result.status).toBe("updated");
    expect(fake.minted()).toBe(2);
    const auths = gatewayCalls(fake.calls).map((call) => call.auth);
    expect(auths).toEqual(["Bearer uno_spark_1", "Bearer uno_spark_2"]);
  });

  it("a second 401 is an error, not a loop", async () => {
    const { deps, project, fake } = makeDeps({
      respond: (call) => (call.url.endsWith("/spark/token") ? { status: 0 } : { status: 401 }),
    });
    writeFileSync(path.join(project, "bot.js"), "x");
    const message = failMessage(
      await run("spark_deploy", deps, { path: "bot.js", name: "cafe-bot" }),
    );
    expect(message).toMatch(/didn't accept/);
    expect(fake.minted()).toBe(2);
    expect(gatewayCalls(fake.calls)).toHaveLength(2);
  });

  it("hands a secret from the project's .env to Spark, never into the result", async () => {
    const { deps, project, fake } = makeDeps({});
    writeFileSync(path.join(project, "bot.js"), "x");
    writeFileSync(path.join(project, ".env"), `TELEGRAM_BOT_TOKEN="${SECRET_VALUE}"\n`);
    const result = okValue(
      await run("spark_deploy", deps, {
        path: "bot.js",
        name: "cafe-bot",
        env: [{ name: "GREETING", value: "hi" }],
        secrets: [{ name: "TELEGRAM_BOT_TOKEN", hosts: ["api.telegram.org"] }],
      }),
    );
    const calls = gatewayCalls(fake.calls);
    const env = calls.find((call) => call.url.endsWith("/apps/cafe-bot/env"))!;
    expect(JSON.parse(env.body as string)).toEqual({ GREETING: "hi" });
    const secret = calls.find((call) => call.url.endsWith("/secrets/TELEGRAM_BOT_TOKEN"))!;
    expect(secret.method).toBe("PUT");
    expect(JSON.parse(secret.body as string)).toEqual({
      value: SECRET_VALUE,
      hosts: ["api.telegram.org"],
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain(SECRET_VALUE);
    expect(result.secrets).toEqual([{ name: "TELEGRAM_BOT_TOKEN", hosts: ["api.telegram.org"] }]);
    expect(String(result.note)).toMatch(/setWebhook\?url=https:\/\/cafe-bot\.spark\.uno4\.me\//);
    expect(String(result.note)).toContain("$TELEGRAM_BOT_TOKEN");
  });

  it("a secret missing from .env stops before anything goes up", async () => {
    const { deps, project, fake } = makeDeps({});
    writeFileSync(path.join(project, "bot.js"), "x");
    const message = failMessage(
      await run("spark_deploy", deps, {
        path: "bot.js",
        name: "cafe-bot",
        secrets: [{ name: "TOKEN", fromEnv: "BOT_TOKEN", hosts: ["api.telegram.org"] }],
      }),
    );
    expect(message).toMatch(/BOT_TOKEN isn't in the project's \.env/);
    expect(message).toMatch(/request_secret/);
    expect(fake.calls).toHaveLength(0);
  });

  it("packs a folder as .tar.gz without .env, keys, .git and node_modules", async () => {
    const { deps, project, fake } = makeDeps({});
    mkdirSync(path.join(project, "lib"), { recursive: true });
    mkdirSync(path.join(project, "node_modules", "x"), { recursive: true });
    mkdirSync(path.join(project, ".git"), { recursive: true });
    writeFileSync(path.join(project, "index.js"), "import './lib/util.js'");
    writeFileSync(path.join(project, "lib", "util.js"), "export const a = 1");
    writeFileSync(path.join(project, ".env"), "SECRET=1");
    writeFileSync(path.join(project, "service-account.json"), "{}");
    writeFileSync(path.join(project, "node_modules", "x", "index.js"), "x");
    writeFileSync(path.join(project, ".git", "config"), "x");
    const result = okValue(await run("spark_deploy", deps, { path: ".", name: "cafe-bot" }));
    const put = gatewayCalls(fake.calls)[0]!;
    expect(put.url).toBe(`${SPARK_API_BASE}/apps/cafe-bot?type=js&entry=index.js`);
    expect(put.contentType).toBe("application/gzip");
    const gz = put.body as Uint8Array;
    expect(tarNames(gz).toSorted()).toEqual(["index.js", "lib/util.js"]);
    // A real tar reads it too.
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "uno-spark-tar-")), "a.tar.gz");
    tempDirs.push(path.dirname(file));
    writeFileSync(file, gz);
    const listed = execFileSync("tar", ["-tzf", file], { encoding: "utf8" })
      .trim()
      .split("\n")
      .toSorted();
    expect(listed).toEqual(["index.js", "lib/util.js"]);
    expect(String(result.note)).toMatch(/service-account\.json \(key file\)/);
  });

  it("gives the compiler's text back whole on a 400", async () => {
    const compiler = "SyntaxError: Unexpected token '}'\n  at bot.js:3:1\n".repeat(20);
    const { deps, project } = makeDeps({
      respond: (call) =>
        call.url.endsWith("/spark/token") ? { status: 0 } : { status: 400, body: compiler },
    });
    writeFileSync(path.join(project, "bot.js"), "x");
    const message = failMessage(
      await run("spark_deploy", deps, { path: "bot.js", name: "cafe-bot" }),
    );
    expect(message).toContain(compiler.trim());
    expect(message).toMatch(/Fix the code and deploy again/);
  });

  it("explains a taken name", async () => {
    const { deps, project } = makeDeps({
      respond: (call) =>
        call.url.endsWith("/spark/token")
          ? { status: 0 }
          : { status: 409, body: JSON.stringify({ error: "name_taken" }) },
    });
    writeFileSync(path.join(project, "bot.js"), "x");
    expect(
      failMessage(await run("spark_deploy", deps, { path: "bot.js", name: "cafe-bot" })),
    ).toMatch(/belongs to another Uno account\. Pick another name/);
  });

  it.each([
    ["SPARK_UNAVAILABLE", /isn't switched on for this Uno account/],
    ["ACCOUNT_NOT_CLAIMED", /isn't claimed yet/],
    ["ACCOUNT_DISABLED", /disabled/],
    ["SPARK_TOKEN_CALLER", /can't get a Spark token/],
  ])("tells the console's %s in plain words", async (code, expected) => {
    const { deps, project, fake } = makeDeps({
      respond: (call) =>
        call.url.endsWith("/spark/token")
          ? { status: 403, body: JSON.stringify({ error: code, detail: "d" }) }
          : { status: 200 },
    });
    writeFileSync(path.join(project, "bot.js"), "x");
    expect(
      failMessage(await run("spark_deploy", deps, { path: "bot.js", name: "cafe-bot" })),
    ).toMatch(expected);
    expect(gatewayCalls(fake.calls)).toHaveLength(0);
  });

  it("a computer without an Uno account: connect it in Settings", async () => {
    const unlinked = makeDeps({ credential: "" });
    writeFileSync(path.join(unlinked.project, "bot.js"), "x");
    expect(
      failMessage(await run("spark_deploy", unlinked.deps, { path: "bot.js", name: "cafe-bot" })),
    ).toMatch(/connect this computer to their Uno account \(Settings → Uno account\)/);
    expect(unlinked.fake.calls).toHaveLength(0);

    const noWiring = makeDeps({ noSpark: true });
    expect(failMessage(await run("spark_list", noWiring.deps, {}))).toMatch(
      /Settings → Uno account/,
    );
  });

  it("refuses what isn't JavaScript or Python, and paths outside the home", async () => {
    const { deps, project } = makeDeps({});
    writeFileSync(path.join(project, "bot.ts"), "x");
    expect(
      failMessage(await run("spark_deploy", deps, { path: "bot.ts", name: "cafe-bot" })),
    ).toMatch(/JavaScript \(\.js\) or Python \(\.py\)/);
    expect(
      failMessage(await run("spark_deploy", deps, { path: "/etc/hosts", name: "cafe-bot" })),
    ).toMatch(/inside the home folder/);
    expect(failMessage(await run("spark_deploy", deps, { path: "bot.js", name: "9bad" }))).toMatch(
      /Invalid arguments/,
    );
  });
});

describe("spark_list, spark_logs, spark_delete", () => {
  it("lists apps with their addresses and the account's limits", async () => {
    const { deps } = makeDeps({
      respond: (call) =>
        call.url.endsWith("/spark/token")
          ? { status: 0 }
          : call.url.endsWith("/apps")
            ? { status: 200, body: JSON.stringify({ apps: [{ name: "cafe-bot", version: 3 }] }) }
            : { status: 200, body: JSON.stringify({ plan: "free", apps_used: 1, apps_max: 3 }) },
    });
    expect(okValue(await run("spark_list", deps, {}))).toEqual({
      apps: [{ name: "cafe-bot", version: 3, url: "https://cafe-bot.spark.uno4.me/" }],
      account: { plan: "free", apps_used: 1, apps_max: 3 },
    });
  });

  it("reads the log", async () => {
    const { deps, fake } = makeDeps({
      respond: (call) =>
        call.url.endsWith("/spark/token") ? { status: 0 } : { status: 200, body: "GET / 200" },
    });
    expect(okValue(await run("spark_logs", deps, { name: "cafe-bot", n: 50 }))).toEqual({
      name: "cafe-bot",
      logs: "GET / 200",
    });
    expect(gatewayCalls(fake.calls)[0]!.url).toBe(`${SPARK_API_BASE}/apps/cafe-bot/logs?n=50`);
  });

  it("delete asks the person first and does nothing on a no", async () => {
    const denied = makeDeps({ approval: "denied" });
    expect(failMessage(await run("spark_delete", denied.deps, { name: "cafe-bot" }))).toMatch(
      /declined/,
    );
    expect(denied.approvals).toEqual(["Delete the Spark app https://cafe-bot.spark.uno4.me/"]);
    expect(denied.fake.calls).toHaveLength(0);

    const allowed = makeDeps({});
    okValue(await run("spark_delete", allowed.deps, { name: "cafe-bot" }));
    const call = gatewayCalls(allowed.fake.calls)[0]!;
    expect(call.method).toBe("DELETE");
    expect(call.url).toBe(`${SPARK_API_BASE}/apps/cafe-bot`);
  });
});

describe("readEnvValue", () => {
  it("reads the dotenv dialect the secret writer uses", () => {
    expect(readEnvValue("A=1\nexport B=two # note\n", "B")).toBe("two");
    expect(readEnvValue('C="a \\"b\\"\\nc"', "C")).toBe('a "b"\nc');
    expect(readEnvValue("D='x y'", "D")).toBe("x y");
    expect(readEnvValue("E=", "E")).toBeNull();
    expect(readEnvValue("# F=1", "F")).toBeNull();
  });
});
