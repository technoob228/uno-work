/**
 * The web socket's team methods (T51): what this computer does for the
 * people of a project. Their own group and layer (WsTeamRpcGroup): ws.ts
 * serves them next to the main group.
 *
 * @module team/wsHandlers
 */
import { WS_METHODS, WsTeamRpcGroup } from "@t3tools/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { TeamCollab } from "./TeamCollab.ts";

const attributes = { "rpc.aggregate": "team" };

export const TeamRpcLayer = WsTeamRpcGroup.toLayer(
  Effect.gen(function* () {
    const team = yield* TeamCollab;
    return WsTeamRpcGroup.of({
      [WS_METHODS.teamState]: (_input) =>
        observeRpcEffect(WS_METHODS.teamState, team.state, attributes),
      [WS_METHODS.teamRefresh]: (_input) =>
        observeRpcEffect(WS_METHODS.teamRefresh, team.refresh, attributes),
      [WS_METHODS.teamLetAgentAnswer]: (input) =>
        observeRpcEffect(
          WS_METHODS.teamLetAgentAnswer,
          team.letAgentAnswer(input.requestId),
          attributes,
        ),
    });
  }),
);
