import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { ASSISTANT_PROJECT_ID, ManagerSlackConnectorConfig, ProjectId } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { ManagerConnectorRepositoryLive } from "../persistence/Layers/ManagerConnectors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { CONTROL_PLANE_URL_OVERRIDE_ENV } from "../workspaceRegistry/unoCloudParse.ts";
import { assignSlackChannelsFor, slackRoutingStatus } from "./channelSetup.ts";
import {
  channelRoutedAway,
  channelsToClaim,
  keepRoutedChannels,
  parseSlackRouting,
  setSlackDefaultHere,
  syncSlackRouting,
  type SlackRouting,
} from "./slackRouting.ts";

const CONSOLE = "http://console.test";
const SLR = "slr_" + "c".repeat(64);
const ana = ProjectId.make("assistant-ana");

const routingJson = (over: Record<string, unknown> = {}) => ({
  team_id: "T1",
  team_name: "Acme",
  channel_ids: [],
  elsewhere: [],
  taken: [],
  default: false,
  default_chosen: false,
  default_computer: { name: "Work", kind: "cloud", this: false, default: true, channel_count: 2 },
  computers: [
    { name: "Work", kind: "cloud", this: false, default: true, channel_count: 2 },
    { name: "Mac", kind: "desktop", this: true, default: false, channel_count: 0 },
  ],
  shared: false,
  signed_as: "",
  ...over,
});

const routing = (over: Partial<SlackRouting> = {}): SlackRouting => ({
  channelIds: [],
  elsewhere: [],
  taken: [],
  refused: [],
  isDefault: false,
  defaultChosen: false,
  defaultComputer: null,
  computers: [],
  shared: false,
  signedAs: null,
  ...over,
});

describe("slack routing (pure)", () => {
  it("parses the console's answer", () => {
    const parsed = parseSlackRouting(
      routingJson({
        channel_ids: ["C1"],
        taken: ["C9"],
        shared: true,
        signed_as: "Bob's assistant",
      }),
    );
    expect(parsed).toMatchObject({
      channelIds: ["C1"],
      taken: ["C9"],
      shared: true,
      signedAs: "Bob's assistant",
      defaultComputer: { name: "Work", kind: "cloud", isThis: false, isDefault: true },
    });
    expect(parsed?.computers.map((c) => c.isThis)).toEqual([false, true]);
    expect(parseSlackRouting({ ok: true })).toBeNull();
    expect(parseSlackRouting(null)).toBeNull();
  });

  it("claims local channels, not DMs, not what answers elsewhere unless just picked", () => {
    const r = routing({ elsewhere: ["CMOVED"], taken: ["CBOB"] });
    expect(
      channelsToClaim({
        local: [
          ["DME", "CGEN", "CMOVED", "CBOB"],
          ["CANA", "U1"],
        ],
        routing: r,
      }),
    ).toEqual(["CANA", "CGEN"]);
    expect(
      channelsToClaim({
        local: [["CGEN", "CMOVED", "CBOB"]],
        routing: r,
        picked: ["CMOVED", "CBOB"],
      }),
    ).toEqual(["CBOB", "CGEN", "CMOVED"]);
    expect(channelsToClaim({ local: [["CGEN"]], routing: null })).toEqual(["CGEN"]);
  });

  it("keeps DMs and non-channels, and only the channels routed here", () => {
    expect(
      keepRoutedChannels(["DME", "CGEN", "CBOB", "U1"], routing({ channelIds: ["CGEN"] })),
    ).toEqual(["DME", "CGEN", "U1"]);
  });

  it("tells where a channel answers", () => {
    const r = routing({ elsewhere: ["C1"], taken: ["C2"] });
    expect(channelRoutedAway("C1", r)).toBe("computer");
    expect(channelRoutedAway("C2", r)).toBe("account");
    expect(channelRoutedAway("C3", r)).toBeNull();
    expect(channelRoutedAway("C1", null)).toBeNull();
  });

  it("maps to the interface's status", () => {
    const status = slackRoutingStatus(parseSlackRouting(routingJson({ shared: true }))!);
    expect(status).toEqual({
      computers: [
        { name: "Work", kind: "cloud", isThis: false, isDefault: true },
        { name: "Mac", kind: "desktop", isThis: true, isDefault: false },
      ],
      isDefault: false,
      defaultChosen: false,
      shared: true,
      signedAs: null,
    });
  });
});

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

/** A console with this computer's routing; PUT applies like the console does. */
const fakeConsole = (state: {
  channelIds: string[];
  elsewhere: string[];
  taken: string[];
  isDefault?: boolean;
}) => {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      calls.push({ method: init?.method ?? "GET", url, body });
      if (!url.endsWith(`/api/v1/work-relay/slack/${SLR}/routing`)) {
        return new Response("not found", { status: 404 });
      }
      let refused: string[] = [];
      if (init?.method === "PUT" && Array.isArray(body?.channel_ids)) {
        const wanted = body.channel_ids as string[];
        refused = wanted.filter((id) => state.taken.includes(id));
        state.channelIds = wanted.filter((id) => !state.taken.includes(id));
        state.elsewhere = state.elsewhere.filter((id) => !state.channelIds.includes(id));
      }
      if (init?.method === "PUT" && typeof body?.default === "boolean") {
        state.isDefault = body.default;
      }
      return Response.json(
        routingJson({
          channel_ids: state.channelIds,
          elsewhere: state.elsewhere,
          taken: state.taken,
          refused,
          default: state.isDefault === true,
          default_chosen: state.isDefault === true,
        }),
      );
    }),
  );
  return calls;
};

const repositories = ManagerConnectorRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const saveRow = (projectId: ProjectId, botToken: string, allowedChannelIds: string[]) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    yield* repository.upsert({
      projectId,
      kind: "slack",
      config: { botToken, appToken: "unorelay", allowedChannelIds, enabled: true },
      updatedAt: new Date().toISOString(),
    });
  });

const allowedOf = (projectId: ProjectId) =>
  Effect.gen(function* () {
    const repository = yield* ManagerConnectorRepository;
    const row = yield* repository.get({ projectId, kind: "slack" });
    return Option.isSome(row)
      ? Schema.decodeUnknownSync(ManagerSlackConnectorConfig)(row.value.config).allowedChannelIds
      : null;
  });

beforeEach(() => {
  vi.stubEnv(CONTROL_PLANE_URL_OVERRIDE_ENV, CONSOLE);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.layer(NodeServices.layer)("slack routing with the console", (it) => {
  it.effect("claims this computer's channels and drops what answers elsewhere", () =>
    Effect.gen(function* () {
      yield* saveRow(ASSISTANT_PROJECT_ID, `unorelay:${SLR}`, ["DINST", "CGEN", "CMOVED"]);
      yield* saveRow(ana, `unoroute:${ASSISTANT_PROJECT_ID}`, ["CBOB", "CANA"]);
      const calls = fakeConsole({ channelIds: [], elsewhere: ["CMOVED"], taken: ["CBOB"] });

      const result = yield* syncSlackRouting();
      expect(result?.channelIds).toEqual(["CANA", "CGEN"]);
      const put = calls.find((call) => call.method === "PUT");
      expect(put?.body).toEqual({ channel_ids: ["CANA", "CGEN"] });
      expect(yield* allowedOf(ASSISTANT_PROJECT_ID)).toEqual(["DINST", "CGEN"]);
      expect(yield* allowedOf(ana)).toEqual(["CANA"]);

      // In line already: no PUT the second time.
      const before = calls.length;
      yield* syncSlackRouting();
      expect(calls.slice(before).map((call) => call.method)).toEqual(["GET"]);
    }).pipe(Effect.provide(repositories)),
  );

  it.effect("picking a channel moves it here; another account's stays there", () =>
    Effect.gen(function* () {
      yield* saveRow(ASSISTANT_PROJECT_ID, `unorelay:${SLR}`, ["DINST", "CGEN"]);
      const state = { channelIds: ["CGEN"], elsewhere: ["CBUILD"], taken: ["CBOB"] };
      fakeConsole(state);

      const assigned = yield* assignSlackChannelsFor({
        projectId: ASSISTANT_PROJECT_ID,
        channelIds: ["CGEN", "CBUILD", "CBOB"],
      });
      expect(assigned).toEqual(["DINST", "CGEN", "CBUILD"]);
      expect(state.channelIds).toEqual(["CBUILD", "CGEN"]);
      expect(state.elsewhere).toEqual([]);
    }).pipe(Effect.provide(repositories)),
  );

  it.effect("an older console (no routing) leaves the allowlists alone", () =>
    Effect.gen(function* () {
      yield* saveRow(ASSISTANT_PROJECT_ID, `unorelay:${SLR}`, ["CGEN"]);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("not found", { status: 404 })),
      );
      expect(yield* syncSlackRouting()).toBeNull();
      expect(
        yield* assignSlackChannelsFor({ projectId: ASSISTANT_PROJECT_ID, channelIds: ["CNEW"] }),
      ).toEqual(["CNEW"]);
    }).pipe(Effect.provide(repositories)),
  );

  it.effect("answer direct messages here", () =>
    Effect.gen(function* () {
      yield* saveRow(ASSISTANT_PROJECT_ID, `unorelay:${SLR}`, []);
      const calls = fakeConsole({ channelIds: [], elsewhere: [], taken: [] });
      const result = yield* setSlackDefaultHere({ isDefault: true });
      expect(result).toMatchObject({ isDefault: true, defaultChosen: true });
      expect(calls.at(-1)).toMatchObject({ method: "PUT", body: { default: true } });
    }).pipe(Effect.provide(repositories)),
  );

  it.effect("no relay on this computer: nothing to sync", () =>
    Effect.gen(function* () {
      yield* saveRow(ASSISTANT_PROJECT_ID, "xoxb-own", ["CGEN"]);
      const calls = fakeConsole({ channelIds: [], elsewhere: [], taken: [] });
      expect(yield* syncSlackRouting()).toBeNull();
      expect(yield* setSlackDefaultHere({ isDefault: true })).toBeNull();
      expect(calls).toEqual([]);
    }).pipe(Effect.provide(repositories)),
  );
});
