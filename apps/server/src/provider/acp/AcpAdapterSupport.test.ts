import { describe, expect, it } from "vitest";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import type { ProviderApprovalDecision } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  acpPermissionResponse,
  mapAcpToAdapterError,
  selectPermissionOptionForDecision,
} from "./AcpAdapterSupport.ts";

type Options = EffectAcpSchema.RequestPermissionRequest["options"];

const request = (options: Options): EffectAcpSchema.RequestPermissionRequest => ({
  sessionId: "s",
  toolCall: { toolCallId: "t" },
  options,
});

/** As Hermes offers them (acp_adapter/permissions.py, 0.19 and 0.21). */
const HERMES_COMMAND: Options = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
  { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
  { optionId: "deny_always", name: "Deny always", kind: "reject_always" },
];
/** A file edit (acp_adapter/edit_approval.py): only these two. */
const HERMES_EDIT: Options = [
  { optionId: "allow_once", name: "Allow edit", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];
const CURSOR: Options = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject-once", name: "Reject", kind: "reject_once" },
];

describe("AcpAdapterSupport", () => {
  const cases: ReadonlyArray<
    readonly [string, Options, Record<ProviderApprovalDecision, string | undefined>]
  > = [
    [
      "Hermes, a command",
      HERMES_COMMAND,
      {
        accept: "allow_once",
        // "This chat": the option Hermes keeps for the session, not the permanent one.
        acceptForSession: "allow_session",
        decline: "deny",
        cancel: undefined,
      },
    ],
    [
      "Hermes, a file edit",
      HERMES_EDIT,
      {
        accept: "allow_once",
        acceptForSession: "allow_once",
        decline: "deny",
        cancel: undefined,
      },
    ],
    [
      "Cursor",
      CURSOR,
      {
        accept: "allow-once",
        acceptForSession: "allow-always",
        decline: "reject-once",
        cancel: undefined,
      },
    ],
  ];

  for (const [agent, options, expected] of cases) {
    it(`answers ${agent} with an option it offered`, () => {
      for (const [decision, optionId] of Object.entries(expected)) {
        expect(
          selectPermissionOptionForDecision(request(options), decision as ProviderApprovalDecision),
        ).toBe(optionId);
      }
    });
  }

  it("answers cancelled when the person cancels or nothing fits", () => {
    expect(acpPermissionResponse(request(CURSOR), "cancel")).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(acpPermissionResponse(request([]), "accept")).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(acpPermissionResponse(request(HERMES_EDIT), "accept")).toEqual({
      outcome: { outcome: "selected", optionId: "allow_once" },
    });
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
