import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import { Schema } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

type PermissionKind = EffectAcpSchema.PermissionOptionKind;

export function optionOfKinds(
  request: EffectAcpSchema.RequestPermissionRequest,
  kinds: ReadonlyArray<PermissionKind>,
): string | undefined {
  for (const kind of kinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    const id = option?.optionId?.trim();
    if (id) return id;
  }
  return undefined;
}

/**
 * Our decision → one of the options the agent offered, by the standard `kind`
 * (allow_once / allow_always / reject_once / reject_always), never by an id
 * built here: every agent names them its own way (Hermes `allow_once` and
 * `deny`, Cursor `allow-once` and `reject-once`), and an id it didn't offer
 * reads as a refusal. `undefined` means "answer `cancelled`": the agent offered
 * nothing matching, or the person cancelled.
 */
export function selectPermissionOptionForDecision(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  switch (decision) {
    case "accept":
      return optionOfKinds(request, ["allow_once", "allow_always"]);
    case "acceptForSession":
      return optionOfKinds(request, ["allow_always", "allow_once"]);
    case "decline":
      return optionOfKinds(request, ["reject_once", "reject_always"]);
    default:
      return undefined;
  }
}

/** The answer to `session/request_permission` for the person's decision. */
export function acpPermissionResponse(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): EffectAcpSchema.RequestPermissionResponse {
  const optionId = selectPermissionOptionForDecision(request, decision);
  return {
    outcome: optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
  };
}
