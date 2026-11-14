/**
 * One call on the person's computer through the trust tiers: judged there
 * (`judge.ts`), decided for this chat (`decide.ts`), and what follows — a
 * refusal in the journal, the chat's Allow after an approval, the idle clock.
 * The `trust` hook of every `my_computer_*` and `workspace_*` tool.
 *
 * @module myComputer/trust/gate
 */
import type { MyComputerActivityKind } from "@t3tools/contracts";
import { Effect } from "effect";

import type { ComputerTrustGate, UnoWorkToolDeps, UnoWorkToolError } from "../../unoWork/tools.ts";
import type { MyComputerShape } from "../MyComputerService.ts";
import { decideTrust, STOPPED_MESSAGE, type TrustOpKind } from "./decide.ts";
import type { TrustOperation } from "./judge.ts";

export interface TrustGateInput {
  readonly deps: UnoWorkToolDeps;
  readonly api: MyComputerShape;
  readonly computer: { readonly id: string; readonly name: string; readonly os: string };
  readonly operation: TrustOperation;
  /** The journal's word for it, and its line. */
  readonly journal: { readonly kind: MyComputerActivityKind; readonly summary: string };
  /** Allowed for this call too: the chat's project folder there. */
  readonly extraAllowed?: ReadonlyArray<string> | undefined;
  readonly context: { readonly cautious: boolean; readonly outsideText: boolean };
  readonly fail: (message: string) => UnoWorkToolError;
}

const opKind = (operation: TrustOperation): TrustOpKind =>
  operation.kind === "run" ? "run" : operation.kind === "read" ? "read" : "write";

export function computerTrustGate(
  input: TrustGateInput,
): Effect.Effect<ComputerTrustGate, UnoWorkToolError> {
  const { deps, api, computer } = input;
  const threadId = deps.caller.threadId;
  const threadTitle = deps.caller.threadTitle;
  return Effect.tryPromise({
    try: async (signal): Promise<ComputerTrustGate> => {
      const refuse = async (
        tier: ComputerTrustGate["trust"]["tier"],
        reason: string,
        message: string,
      ): Promise<ComputerTrustGate> => {
        await api.core.refused({
          computerId: computer.id,
          kind: input.journal.kind,
          summary: input.journal.summary,
          threadId,
          threadTitle,
          tier,
          reason,
        });
        return { verdict: "refuse", message, trust: { tier, threadTitle } };
      };
      const paused = await api.trust.paused();
      if (paused?.reason === "stopped") {
        return refuse("ask", "agents stopped by the person", STOPPED_MESSAGE);
      }
      const settings = await api.trust.settings();
      const judged = await api.judge.judge(
        {
          computerId: computer.id,
          os: computer.os,
          allowedFolders: settings.allowedFolders,
          allowedCommands: settings.allowedCommands,
          extraAllowed: input.extraAllowed,
          operation: input.operation,
        },
        signal,
      );
      const decision = decideTrust({
        tier: judged.tier,
        reason: judged.reason,
        kind: opKind(input.operation),
        runtimeMode: deps.caller.runtimeMode,
        cautious: input.context.cautious,
        outsideText: input.context.outsideText,
        grantActive: api.trust.grantActive(threadId, computer.id),
        paused,
        grantHours: settings.grantHours,
      });
      const trust = { tier: judged.tier, threadTitle };
      if (decision.verdict === "refuse") {
        return refuse(judged.tier, judged.reason, decision.message);
      }
      if (decision.verdict === "run") {
        await api.trust.touch();
        return { verdict: "run", trust };
      }
      return {
        verdict: "ask",
        detail: decision.note,
        sensitive: decision.sensitive,
        trust,
        onApproved: Effect.promise(async () => {
          if (decision.resume) await api.trust.resume();
          if (decision.grant) {
            await api.trust.grant({ threadId, threadTitle, computerId: computer.id });
          }
          await api.trust.touch();
        }),
      };
    },
    catch: (cause) =>
      input.fail(
        `Couldn't check what this may do on ${computer.name || "the computer"}: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });
}
