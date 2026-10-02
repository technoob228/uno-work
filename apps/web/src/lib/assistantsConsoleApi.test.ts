import { describe, expect, it } from "vitest";

import {
  parseAssistantComputer,
  parseConnectorPermissions,
  parseSchedules,
} from "./assistantsConsoleApi";

describe("parseAssistantComputer", () => {
  it("reads the console's assistant block", () => {
    expect(
      parseAssistantComputer({
        id: 5,
        name: "assistant-ana-x1",
        status: "sleeping",
        computer_role: "assistant",
        assistant: { name: "Ana", emoji: "📣", template: "marketing", created_at: "2026-10-02" },
      }),
    ).toEqual({
      boxId: 5,
      boxName: "assistant-ana-x1",
      status: "sleeping",
      label: { name: "Ana", emoji: "📣", template: "marketing" },
      createdAt: "2026-10-02",
    });
  });

  it("skips other computers and deleted ones", () => {
    expect(
      parseAssistantComputer({ id: 1, status: "running", computer_role: "workspace" }),
    ).toBeNull();
    expect(
      parseAssistantComputer({ id: 2, status: "deleted", computer_role: "assistant" }),
    ).toBeNull();
  });
});

describe("parseConnectorPermissions", () => {
  it("fills every provider and keeps 'restricted'", () => {
    expect(
      parseConnectorPermissions({
        permissions: { github: "read", gmail: "bogus" },
        default: "none",
        restricted: true,
      }),
    ).toEqual({
      supported: true,
      restricted: true,
      permissions: { gmail: "none", "google-drive": "none", notion: "none", github: "read" },
    });
    expect(
      parseConnectorPermissions({ permissions: {}, default: "write", restricted: false }),
    ).toMatchObject({
      restricted: false,
      permissions: { gmail: "write", github: "write" },
    });
  });
});

describe("parseSchedules", () => {
  it("keeps this computer's tasks and reads the prompt back", () => {
    const list = parseSchedules(
      {
        tasks: [
          {
            id: 1,
            box_id: 5,
            name: "Ana",
            cron_expr: "0 10 * * 1",
            command: "uno-work assistant-turn --prompt 'Post'",
            state: "active",
          },
          { id: 2, box_id: 6, name: "other", cron_expr: "* * * * *", command: "x" },
        ],
      },
      5,
    );
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 1, prompt: "Post", cron: "0 10 * * 1", timezone: "UTC" });
  });
});
