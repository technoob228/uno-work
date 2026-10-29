// @ts-nocheck — runs from a checkout of UPSTREAM t3code (their contracts,
// client-runtime and effect 4.x); our tsconfig does not know those exports.
/**
 * T3 v2 contract smoke: the real upstream client stack (what the store
 * T3 Code phone app bundles) against a Uno Work daemon.
 *
 * Every HTTP body is decoded with upstream's schemas; every WS frame goes
 * through upstream's RpcSession (client-runtime/src/rpc/session.ts) and
 * WsRpcGroup, which decode with upstream's schemas too — a shape we got
 * wrong fails here with the path of the field.
 *
 * Steps (each prints PASS/FAIL; exit 1 on the first FAIL):
 *   descriptor (protocol 2 accepted) → oauth/token → session (operate scope)
 *   → websocket-ticket → HTTP v2 shell → WS connect + initial config + probe
 *   → subscribeShell (snapshot + synchronized) → launchThread (root) →
 *   subscribeThread (snapshot + synchronized) → message.dispatch → agent
 *   reply → approval (runtime-request.respond) → «slow» turn → run.interrupt
 *   → snooze from the phone visible to Work (v1 shell) → settle from Work
 *   (v1 socket) visible to the phone → visit / mark-unread round trip.
 *
 * Needs the fake ACP agent registered as harness-fake
 * (v2-fake-acp-agent.mjs). See README.md «T3 v2 contract smoke».
 *
 *   SMOKE_PAIR_URL='http://127.0.0.1:13791/pair#token=…' node t3v2-contract-smoke.ts
 */
import {
  AuthAccessTokenResult,
  AuthSessionState,
  AuthWebSocketTicketResult,
  ExecutionEnvironmentDescriptor,
  OrchestrationV2ShellSnapshot,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/socket/Socket";
import { randomUUID } from "node:crypto";

import { orchestrationProtocolCompatibilityError } from "./src/connection/compatibility.ts";
import { BearerConnectionTarget } from "./src/connection/model.ts";
import * as RpcSessionFactory from "./src/rpc/session.ts";

const PAIR_URL = process.env.SMOKE_PAIR_URL;
if (!PAIR_URL) throw new Error("SMOKE_PAIR_URL=http://host:port/pair#token=… is required");
const pairUrl = new URL(PAIR_URL);
const PAIRING =
  new URLSearchParams(pairUrl.hash.slice(1)).get("token") ?? pairUrl.searchParams.get("token");
const BASE = pairUrl.origin;
const HARNESS = process.env.SMOKE_HARNESS ?? "harness-fake";
const STEP_TIMEOUT_MS = Number(process.env.SMOKE_STEP_TIMEOUT_MS ?? 60_000);

const results: Array<{ step: string; ok: boolean; detail: string }> = [];
const pass = (step: string, detail: unknown = "") => {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ step, ok: true, detail: text });
  console.log(`PASS ${step}${text ? `: ${text}` : ""}`);
};
class StepFailed extends Error {}
const fail = (step: string, detail: unknown): never => {
  const text =
    detail instanceof Error ? (detail.stack ?? detail.message) : typeof detail === "string" ? detail : JSON.stringify(detail);
  results.push({ step, ok: false, detail: text });
  console.log(`FAIL ${step}: ${text}`);
  throw new StepFailed(step);
};

const decodeJson = (schema) => Schema.decodeUnknownSync(Schema.toCodecJson(schema));
const V2 = { "x-t3-orchestration-protocol": "2" };

async function httpStep(step: string, run: () => Promise<unknown>) {
  try {
    return await run();
  } catch (error) {
    return fail(step, error);
  }
}

// ---------------------------------------------------------------- HTTP ----
const descriptorRaw = await httpStep("descriptor", async () =>
  (await fetch(`${BASE}/.well-known/t3/environment`)).json(),
);
const descriptor = await httpStep("descriptor", async () => decodeJson(ExecutionEnvironmentDescriptor)(descriptorRaw));
const incompatible = orchestrationProtocolCompatibilityError(descriptor);
if (incompatible) fail("descriptor", incompatible.detail);
pass("descriptor", {
  protocol: descriptor.orchestrationProtocolVersion,
  serverVersion: descriptor.serverVersion,
  capabilities: Object.keys(descriptor.capabilities).filter((key) => descriptor.capabilities[key]),
});

const token = await httpStep("oauth/token", async () => {
  const response = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: PAIRING,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      client_label: "T3 v2 contract smoke",
    }),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return decodeJson(AuthAccessTokenResult)(await response.json());
});
pass("oauth/token", { scope: token.scope });
const auth = { authorization: `Bearer ${token.access_token}` };

const session = await httpStep("session", async () =>
  decodeJson(AuthSessionState)(await (await fetch(`${BASE}/api/auth/session`, { headers: auth })).json()),
);
if (!session.authenticated || !(session.scopes ?? []).includes("orchestration:operate")) {
  fail("session", { authenticated: session.authenticated, scopes: session.scopes });
}
pass("session", { scopes: session.scopes });

const httpShell = await httpStep("GET /api/orchestration/shell (v2)", async () =>
  decodeJson(OrchestrationV2ShellSnapshot)(
    await (await fetch(`${BASE}/api/orchestration/shell`, { headers: { ...auth, ...V2 } })).json(),
  ),
);
pass("GET /api/orchestration/shell (v2)", {
  projects: httpShell.projects.length,
  threads: httpShell.threads.length,
  archived: httpShell.archivedThreads.length,
});

const v1Shell = async () =>
  (await fetch(`${BASE}/api/orchestration/shell`, { headers: auth })).json();

const ticketFor = async () =>
  decodeJson(AuthWebSocketTicketResult)(
    await (await fetch(`${BASE}/api/auth/websocket-ticket`, { method: "POST", headers: auth })).json(),
  );

// ------------------------------------------------------------------ WS ----
const socketUrl = (ticket: string, protocol: "2" | null) => {
  const url = new URL(`${BASE.replace(/^http/, "ws")}/ws`);
  url.searchParams.set("wsTicket", ticket);
  if (protocol) url.searchParams.set("orchestrationProtocol", protocol);
  url.searchParams.set("clientSurface", "mobile");
  url.searchParams.set("clientDeviceType", "phone");
  url.searchParams.set("connectionMethod", "direct");
  url.searchParams.set("clientOs", "ios");
  url.searchParams.set("clientAppVersion", "smoke");
  return url.toString();
};

const waitFor = <A>(step: string, read: () => A | undefined | null | false, timeoutMs = STEP_TIMEOUT_MS) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = read();
      if (value) return value as A;
      yield* Effect.sleep(Duration.millis(100));
    }
    return fail(step, `timed out after ${timeoutMs} ms`);
  });

const step = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeout(Duration.millis(STEP_TIMEOUT_MS)),
    Effect.catchCause((cause) => Effect.sync(() => fail(name, String(cause)))),
  );

const program = Effect.gen(function* () {
  const factory = yield* RpcSessionFactory.make({});
  const connect = (protocol: "2" | null, label: string) =>
    Effect.gen(function* () {
      const ticket = yield* Effect.promise(ticketFor);
      return yield* factory.connect({
        environmentId: descriptor.environmentId,
        label,
        httpBaseUrl: BASE,
        socketUrl: socketUrl(ticket.ticket, protocol),
        httpAuthorization: null,
        target: new BearerConnectionTarget({
          environmentId: descriptor.environmentId,
          label,
          connectionId: "smoke",
        }),
      });
    });

  const phone = yield* step("ws connect (protocol 2)", connect("2", "phone"));
  const config = yield* step("ws initial config", phone.initialConfig);
  const fake = config.providers.find((provider) => provider.instanceId === HARNESS);
  if (!fake) fail("ws initial config", `provider ${HARNESS} not found: ${config.providers.map((p) => p.instanceId)}`);
  pass("ws initial config", { providers: config.providers.map((provider) => provider.instanceId) });
  yield* step("server.probe", phone.probe);
  pass("server.probe");

  const client = phone.client;

  // ---- shell -------------------------------------------------------------
  const shellItems: Array<any> = [];
  yield* client["orchestration.subscribeShell"]({ requestCompletionMarker: true }).pipe(
    Stream.runForEach((item) => Effect.sync(() => shellItems.push(item))),
    Effect.catchCause((cause) => Effect.sync(() => shellItems.push({ kind: "error", cause: String(cause) }))),
    Effect.forkScoped,
  );
  yield* waitFor("subscribeShell", () =>
    shellItems.some((item) => item.kind === "error")
      ? fail("subscribeShell", shellItems.find((item) => item.kind === "error").cause)
      : shellItems.some((item) => item.kind === "synchronized"),
  );
  const shellSnapshot = shellItems.find((item) => item.kind === "snapshot").snapshot;
  const project = shellSnapshot.projects[0];
  if (!project) fail("subscribeShell", "no project in the shell (start the daemon with a project folder)");
  pass("subscribeShell", {
    projects: shellSnapshot.projects.length,
    threads: shellSnapshot.threads.length,
    order: shellItems.slice(0, 2).map((item) => item.kind),
  });
  const shellThread = (threadId: string) => {
    let latest;
    for (const item of shellItems) {
      if (item.kind === "snapshot") {
        latest =
          item.snapshot.threads.find((thread) => thread.id === threadId) ??
          item.snapshot.archivedThreads.find((thread) => thread.id === threadId) ??
          latest;
      }
      if (item.kind === "thread.updated" && item.thread.id === threadId) latest = item.thread;
    }
    return latest;
  };

  // ---- new chat ----------------------------------------------------------
  const launched = yield* step(
    "launchThread (root)",
    client["orchestration.launchThread"]({
      commandId: randomUUID(),
      projectId: project.id,
      title: "T3 v2 smoke",
      modelSelection: { instanceId: HARNESS, model: fake.models[0]?.slug ?? "fake-1" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    }),
  );
  const threadId = launched.threadId;
  pass("launchThread (root)", { threadId });

  const threadItems: Array<any> = [];
  yield* client["orchestration.subscribeThread"]({
    threadId,
    requestCompletionMarker: true,
    acceptDedupedBodies: true,
  }).pipe(
    Stream.runForEach((item) => Effect.sync(() => threadItems.push(item))),
    Effect.catchCause((cause) => Effect.sync(() => threadItems.push({ kind: "error", cause: String(cause) }))),
    Effect.forkScoped,
  );
  yield* waitFor("subscribeThread", () =>
    threadItems.some((item) => item.kind === "error")
      ? fail("subscribeThread", threadItems.find((item) => item.kind === "error").cause)
      : threadItems.some((item) => item.kind === "synchronized"),
  );
  pass("subscribeThread", { order: threadItems.slice(0, 2).map((item) => item.kind) });
  const projection = () => threadItems.findLast((item) => item.kind === "snapshot")?.projection;
  const assistantTexts = () =>
    (projection()?.visibleTurnItems ?? [])
      .map((row) => row.item)
      .filter((item) => item.type === "assistant_message" && !item.streaming)
      .map((item) => item.text);
  const dispatch = (command) =>
    client["orchestration.dispatchCommand"]({ commandId: randomUUID(), threadId, ...command });
  const send = (text: string) =>
    dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "mobile",
      messageId: randomUUID(),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });
  const runIdle = () => {
    const runs = projection()?.runs ?? [];
    return runs.length > 0 && !["preparing", "queued", "starting", "running", "waiting"].includes(runs.at(-1).status);
  };

  // ---- write + read the reply ---------------------------------------------
  yield* step("message.dispatch", send("ping"));
  yield* waitFor("agent reply", () => assistantTexts().some((text) => text.includes("pong: ping")));
  yield* waitFor("agent reply (run settled)", runIdle);
  pass("agent reply", { texts: assistantTexts() });

  // ---- approval ------------------------------------------------------------
  yield* step("message.dispatch (approval)", send("approve this"));
  const request = yield* waitFor("approval requested", () =>
    (projection()?.runtimeRequests ?? []).find((entry) => entry.status === "pending"),
  );
  const badge = yield* waitFor("approval badge in shell", () => shellThread(threadId)?.pendingRuntimeRequest);
  pass("approval requested", { requestId: request.id, kind: request.kind, shellStatus: shellThread(threadId)?.status, badge: badge.id });
  yield* step(
    "runtime-request.respond",
    dispatch({ type: "runtime-request.respond", requestId: request.id, decision: "accept" }),
  );
  yield* waitFor("approved reply", () => assistantTexts().some((text) => text.includes("approved")));
  yield* waitFor("approved (run settled)", runIdle);
  pass("runtime-request.respond", { texts: assistantTexts() });

  // ---- stop -----------------------------------------------------------------
  yield* step("message.dispatch (slow)", send("slow please"));
  const run = yield* waitFor("slow run running", () =>
    (projection()?.runs ?? []).find((entry) => entry.status === "running"),
  );
  yield* step("run.interrupt", dispatch({ type: "run.interrupt", runId: run.id }));
  yield* waitFor("run interrupted", runIdle);
  pass("run.interrupt", { run: run.id, status: projection().runs.at(-1).status });

  // ---- sidebar state: phone → Work ----------------------------------------
  const until = new Date(Date.now() + 3_600_000).toISOString();
  yield* step("thread.snooze (phone)", dispatch({ type: "thread.snooze", snoozedUntil: until }));
  const workSnoozed = yield* Effect.promise(async () => {
    for (let i = 0; i < 50; i += 1) {
      const shell = await v1Shell();
      const row = shell.threads.find((thread) => thread.id === threadId);
      if (row?.snoozedUntil) return row;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  });
  if (!workSnoozed) fail("snooze visible in Work", "v1 shell row has no snoozedUntil");
  pass("snooze visible in Work", { snoozedUntil: workSnoozed.snoozedUntil });
  yield* step("thread.unsnooze (phone)", dispatch({ type: "thread.unsnooze", reason: "user" }));

  // ---- sidebar state: Work → phone ----------------------------------------
  const work = yield* step("ws connect (Work, v1)", connect(null, "work"));
  yield* step("Work initial config", work.initialConfig);
  yield* step(
    "thread.settle (Work)",
    work.client["orchestration.dispatchCommand"]({ type: "thread.settle", commandId: randomUUID(), threadId }),
  );
  yield* waitFor("settle visible on the phone", () => shellThread(threadId)?.settledOverride === "settled");
  pass("settle visible on the phone", { settledAt: shellThread(threadId).settledAt });

  // ---- read state ----------------------------------------------------------
  const visitedAt = new Date().toISOString();
  yield* step("thread.visit (phone)", dispatch({ type: "thread.visit", visitedAt, opened: true }));
  yield* waitFor("visit in shell", () => shellThread(threadId)?.lastVisitedAt);
  const workVisited = yield* Effect.promise(async () =>
    (await v1Shell()).threads.find((thread) => thread.id === threadId)?.lastVisitedAt ?? null,
  );
  if (!workVisited) fail("visit visible in Work", "v1 shell row has no lastVisitedAt");
  yield* step("thread.mark-unread (phone)", dispatch({ type: "thread.mark-unread" }));
  yield* waitFor("unread in shell", () => shellThread(threadId)?.lastVisitedAt === null);
  pass("read state round trip", { visitedAt: workVisited });

  // ---- unsupported command stays polite ------------------------------------
  const refused = yield* dispatch({ type: "thread.model-selection.set", modelSelection: { instanceId: HARNESS, model: "x" } }).pipe(
    Effect.flip,
    Effect.timeout(Duration.millis(10_000)),
    Effect.catchCause((cause) => Effect.sync(() => fail("polite refusal", String(cause)))),
  );
  pass("polite refusal", { tag: refused._tag, message: refused.message });
});

const exit = await Effect.runPromiseExit(
  program.pipe(Effect.scoped, Effect.provide(Socket.layerWebSocketConstructorGlobal)),
);
const failed = results.find((result) => !result.ok);
console.log(
  `\nRESULT ${failed ? "RED" : exit._tag === "Success" ? "GREEN" : "RED"} — ${results.filter((r) => r.ok).length} passed${failed ? `, first failure: ${failed.step}` : ""}`,
);
if (exit._tag === "Failure" && !failed) console.log(String(exit.cause));
process.exit(failed || exit._tag === "Failure" ? 1 : 0);
