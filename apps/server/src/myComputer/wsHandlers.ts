/**
 * The web socket's "Connect my computer" methods. Their own group and layer
 * (see WsMyComputerRpcGroup): ws.ts serves them next to the main group.
 */
import { WS_METHODS, WsMyComputerRpcGroup } from "@t3tools/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { ChatImportService } from "./import/ChatImportService.ts";
import { MyComputerService } from "./MyComputerService.ts";

const attributes = { "rpc.aggregate": "myComputer" };

export const MyComputerRpcLayer = WsMyComputerRpcGroup.toLayer(
  Effect.gen(function* () {
    const myComputer = yield* MyComputerService;
    const chatImport = yield* ChatImportService;
    return WsMyComputerRpcGroup.of({
      [WS_METHODS.myComputerStatus]: (_input) =>
        observeRpcEffect(WS_METHODS.myComputerStatus, myComputer.status, attributes),
      [WS_METHODS.myComputerPair]: (_input) =>
        observeRpcEffect(WS_METHODS.myComputerPair, myComputer.pair, attributes),
      [WS_METHODS.myComputerPairStatus]: ({ code }) =>
        observeRpcEffect(WS_METHODS.myComputerPairStatus, myComputer.pairStatus(code), attributes),
      [WS_METHODS.myComputerDisconnect]: ({ computerId }) =>
        observeRpcEffect(
          WS_METHODS.myComputerDisconnect,
          myComputer.disconnect(computerId),
          attributes,
        ),
      [WS_METHODS.myComputerActivity]: ({ computerId, limit }) =>
        observeRpcEffect(
          WS_METHODS.myComputerActivity,
          myComputer.activity(computerId, limit),
          attributes,
        ),
      [WS_METHODS.myComputerImportStatus]: ({ computerId }) =>
        observeRpcEffect(
          WS_METHODS.myComputerImportStatus,
          chatImport.status(computerId),
          attributes,
        ),
      [WS_METHODS.myComputerImportScan]: ({ computerId }) =>
        observeRpcEffect(WS_METHODS.myComputerImportScan, chatImport.scan(computerId), attributes),
      [WS_METHODS.myComputerImportStart]: ({ computerId, tools }) =>
        observeRpcEffect(
          WS_METHODS.myComputerImportStart,
          chatImport.start(computerId, tools),
          attributes,
        ),
      [WS_METHODS.myComputerImportDecline]: ({ computerId }) =>
        observeRpcEffect(
          WS_METHODS.myComputerImportDecline,
          chatImport.decline(computerId),
          attributes,
        ),
      [WS_METHODS.myComputerChatHistory]: ({ threadId }) =>
        observeRpcEffect(
          WS_METHODS.myComputerChatHistory,
          chatImport.history(threadId),
          attributes,
        ),
    });
  }),
);
