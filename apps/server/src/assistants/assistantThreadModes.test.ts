import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { realignAssistantThreadModes } from "./assistantThreadModes.ts";

const thread = (overrides: Record<string, unknown>) => ({
  id: "t",
  projectId: "assistant-ada",
  archivedAt: null,
  runtimeMode: "full-access",
  ...overrides,
});

describe("realignAssistantThreadModes", () => {
  it("narrows the assistant's live chats to its mode and leaves the rest alone", async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const changed = await Effect.runPromise(
      realignAssistantThreadModes(
        {
          projections: {
            getShellSnapshot: () =>
              Effect.succeed({
                threads: [
                  thread({ id: "a" }),
                  thread({ id: "b", runtimeMode: "auto-accept-edits" }),
                  thread({ id: "c", archivedAt: "2026-10-01T00:00:00Z" }),
                  thread({ id: "d", projectId: "assistant-bob" }),
                  thread({ id: "e", projectId: "site" }),
                ],
              } as never),
          },
          engine: {
            dispatch: ((command: Record<string, unknown>) => {
              dispatched.push(command);
              return Effect.void;
            }) as never,
          },
        },
        "assistant-ada",
        "auto-accept-edits",
      ),
    );
    expect(changed).toBe(1);
    expect(dispatched).toEqual([
      expect.objectContaining({
        type: "thread.runtime-mode.set",
        threadId: "a",
        runtimeMode: "auto-accept-edits",
      }),
    ]);
  });

  it("a failed change is logged, not thrown", async () => {
    const changed = await Effect.runPromise(
      realignAssistantThreadModes(
        {
          projections: {
            getShellSnapshot: () => Effect.succeed({ threads: [thread({ id: "a" })] } as never),
          },
          engine: { dispatch: (() => Effect.fail(new Error("busy"))) as never },
        },
        "assistant-ada",
        "approval-required",
      ),
    );
    expect(changed).toBe(0);
  });
});
