/**
 * The web socket's chat-request methods (a cloud chat asks to start a chat
 * on this computer). Their own group and layer (WsChatRequestsRpcGroup):
 * ws.ts serves them next to the main group.
 *
 * @module chatRequests/wsHandlers
 */
import { WS_METHODS, WsChatRequestsRpcGroup } from "@t3tools/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { ChatRequests } from "./ChatRequests.ts";

const attributes = { "rpc.aggregate": "chatRequests" };

export const ChatRequestsRpcLayer = WsChatRequestsRpcGroup.toLayer(
  Effect.gen(function* () {
    const requests = yield* ChatRequests;
    return WsChatRequestsRpcGroup.of({
      [WS_METHODS.chatRequestsState]: (_input) =>
        observeRpcEffect(WS_METHODS.chatRequestsState, requests.state, attributes),
      [WS_METHODS.chatRequestsDecide]: (input) =>
        observeRpcEffect(WS_METHODS.chatRequestsDecide, requests.decide(input), attributes),
      [WS_METHODS.chatRequestsSetAllowed]: (input) =>
        observeRpcEffect(WS_METHODS.chatRequestsSetAllowed, requests.setAllowed(input), attributes),
    });
  }),
);
