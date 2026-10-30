import type { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { mergeMessageMatches } from "./useMessageSearch";

const match = (id: string, quality: number, at: string) => ({
  threadId: id as ThreadId,
  projectId: "p" as ProjectId,
  messageId: `m-${id}` as MessageId,
  source: "assistant" as const,
  snippet: id,
  messageCreatedAt: at,
  quality,
  hits: 1,
});

describe("mergeMessageMatches", () => {
  it("merges computers: whole words first, then the newest", () => {
    const merged = mergeMessageMatches([
      {
        environmentId: "a" as EnvironmentId,
        matches: [
          match("old-word", 1, "2026-10-01T00:00:00.000Z"),
          match("mid", 0.3, "2026-10-30T00:00:00.000Z"),
        ],
      },
      {
        environmentId: "b" as EnvironmentId,
        matches: [match("new-word", 1, "2026-10-29T00:00:00.000Z")],
      },
    ]);
    expect(merged.map((item) => [item.environmentId, item.threadId])).toEqual([
      ["b", "new-word"],
      ["a", "old-word"],
      ["a", "mid"],
    ]);
  });
});
