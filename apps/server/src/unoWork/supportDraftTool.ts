/**
 * `support_draft`: Fix Work's letter to support, shown as a card in the chat
 * for the person to read, change and send. It sends nothing, so it is `safe`.
 * The daemon takes secrets out before the text is stored (fixWorkReport.ts).
 */
import {
  SUPPORT_DRAFT_MAX_BODY,
  SUPPORT_DRAFT_MAX_SUBJECT,
  SUPPORT_DRAFT_TOOL_NAME,
} from "@t3tools/shared/supportDraft";
import { Effect } from "effect";

import type { UnoWorkTool, UnoWorkToolError } from "./tools.ts";

const text = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
};

export const supportDraftTool = (fail: (message: string) => UnoWorkToolError): UnoWorkTool => ({
  name: SUPPORT_DRAFT_TOOL_NAME,
  group: "person",
  description:
    "Show a draft letter to Uno support in this chat. Nothing is sent: the person reads it and sends it themselves. For Fix Work, or when the person asks to write to support. No keys, file contents or chat contents in it.",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string", maxLength: SUPPORT_DRAFT_MAX_SUBJECT },
      body: { type: "string", maxLength: SUPPORT_DRAFT_MAX_BODY },
    },
    required: ["subject", "body"],
    additionalProperties: false,
  },
  level: "safe",
  run: (deps, args) =>
    Effect.gen(function* () {
      if (!deps.supportDraft) {
        return yield* Effect.fail(fail("Letters to support aren't available on this computer."));
      }
      const subject = text(args, "subject").slice(0, SUPPORT_DRAFT_MAX_SUBJECT);
      const body = text(args, "body").slice(0, SUPPORT_DRAFT_MAX_BODY);
      if (!subject || !body) return yield* Effect.fail(fail("Give the letter a subject and a body."));
      const { redactions } = yield* deps.supportDraft.publish({ subject, body });
      return {
        ok: true,
        redactions,
        message:
          "The draft is on screen. Tell the person it is ready and that they send it themselves. Don't repeat the letter.",
      };
    }),
});
