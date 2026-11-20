import { ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ManagerConnectorBindingRepository } from "../persistence/Services/ManagerConnectorBindings.ts";
import { ManagerConnectorRepository } from "../persistence/Services/ManagerConnectors.ts";
import { ConnectorNotifyServiceLive } from "./Layers/ConnectorNotify.ts";
import { ManagerSlackService } from "./Layers/SlackConnector.ts";
import { ManagerTelegramService } from "./Layers/TelegramConnector.ts";
import { ConnectorNotifyService } from "./Services/ConnectorNotify.ts";

const ASSISTANT = ProjectId.make("assistant-home");
const SITE_CHAT = ThreadId.make("thread-site");

type SlackSent = Parameters<typeof ManagerSlackService.Service.sendText>[0];

/** Only Slack connected (the person's DM with Uno's app); one chat "Build the site". */
function setup() {
  const slack: Array<SlackSent> = [];
  const layer = ConnectorNotifyServiceLive.pipe(
    Layer.provide(
      Layer.mock(ManagerConnectorBindingRepository)({ listAll: () => Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mock(ManagerConnectorRepository)({
        listByKind: (kind) =>
          Effect.succeed(
            kind === "slack"
              ? ([
                  {
                    projectId: ASSISTANT,
                    config: {
                      botToken: "xoxb-1",
                      appToken: "xapp-1",
                      allowedChannelIds: ["D0OWNER"],
                      enabled: true,
                    },
                  },
                ] as never)
              : [],
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed({ threads: [], projects: [] } as never),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getThreadShellById: (threadId) =>
          Effect.succeed(
            threadId === SITE_CHAT
              ? Option.some({
                  id: SITE_CHAT,
                  projectId: ProjectId.make("proj-site"),
                  title: "Build the site",
                } as never)
              : Option.some({ id: threadId, projectId: ASSISTANT, title: "Uno" } as never),
          ),
      }),
    ),
    Layer.provide(Layer.mock(ManagerTelegramService)({})),
    Layer.provide(
      Layer.mock(ManagerSlackService)({
        sendText: (input) =>
          Effect.sync(() => {
            slack.push(input);
            return true;
          }),
      }),
    ),
  );
  const run = <A>(use: (service: typeof ConnectorNotifyService.Service) => Effect.Effect<A>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* ConnectorNotifyService);
      }).pipe(Effect.provide(layer)),
    );
  return { slack, run };
}

describe("a chat writes to the person in Slack", () => {
  it("the reply in the message's thread goes back to that chat (like Reply in Telegram)", async () => {
    const { slack, run } = setup();
    const result = await run((service) =>
      service.sendToPerson({ threadId: SITE_CHAT, text: "The site is live." }),
    );
    expect(result).toMatchObject({ delivered: 1, via: "slack" });
    expect(slack).toHaveLength(1);
    expect(slack[0]!.channelId).toBe("D0OWNER");
    expect(slack[0]!.text).toContain("💬 Build the site");
    expect(slack[0]!.text).toContain("Reply in the thread to answer this chat.");
    expect(slack[0]!.routeReplies).toEqual({ threadId: SITE_CHAT, options: [] });
  });

  it("buttons are numbered and a number picks the button's value", async () => {
    const { slack, run } = setup();
    const result = await run((service) =>
      service.sendToPerson({
        threadId: SITE_CHAT,
        text: "Deploy now?",
        buttons: [
          [
            { label: "Deploy", action: { kind: "reply", value: "Deploy it" } },
            { label: "Wait", action: { kind: "reply", value: "Wait" } },
          ],
        ],
      }),
    );
    expect(result.note).toContain("numbered options");
    expect(slack[0]!.text).toContain("1. Deploy\n2. Wait\n_Reply in the thread with a number._");
    expect(slack[0]!.routeReplies).toEqual({
      threadId: SITE_CHAT,
      options: [
        { label: "Deploy", value: "Deploy it" },
        { label: "Wait", value: "Wait" },
      ],
    });
  });

  it("a choice card keeps its own numbering; the pick sends the option's prompt", async () => {
    const { slack, run } = setup();
    await run((service) =>
      service.sendToPerson({
        threadId: SITE_CHAT,
        text: "Which design?\n\n1. Light\n2. Dark",
        card: {
          kind: "choice",
          question: "Which design?",
          options: [{ label: "Light" }, { label: "Dark", prompt: "Use the dark design" }],
        },
      }),
    );
    expect(slack[0]!.text.match(/1\. Light/g)).toHaveLength(1);
    expect(slack[0]!.text).toContain("_Reply in the thread with a number._");
    expect(slack[0]!.routeReplies?.options).toEqual([
      { label: "Light", value: "Light" },
      { label: "Dark", value: "Use the dark design" },
    ]);
  });

  it("the assistant's own message needs no route: the DM is its conversation", async () => {
    const { slack, run } = setup();
    await run((service) =>
      service.sendToPerson({ threadId: ThreadId.make("thread-uno"), text: "Morning plan ready." }),
    );
    expect(slack[0]!.text).toBe("Morning plan ready.");
    expect(slack[0]!.routeReplies).toBeUndefined();
  });

  it("an approval keeps 'open Uno Work' and no route (Allow stays in Uno Work)", async () => {
    const { slack, run } = setup();
    await run((service) =>
      service.sendToPerson({
        threadId: SITE_CHAT,
        text: "🔐 Publish the site",
        textWithoutButtons: "Agent asks: Publish the site — open Uno Work to Allow or Decline.",
        buttons: [
          [
            {
              label: "Allow",
              action: { kind: "tool-approval", requestId: "r1", approved: true },
            },
          ],
        ],
        approval: true,
      }),
    );
    expect(slack[0]!.text).toContain("open Uno Work to Allow");
    expect(slack[0]!.text).not.toContain("1. Allow");
    expect(slack[0]!.routeReplies).toBeUndefined();
  });
});
