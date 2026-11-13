/**
 * The web socket's "Connect my computer" methods. Their own group and layer
 * (see WsMyComputerRpcGroup): ws.ts serves them next to the main group.
 */
import { WS_METHODS, WsMyComputerRpcGroup } from "@t3tools/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { ChatImportService } from "./import/ChatImportService.ts";
import { MyComputerService } from "./MyComputerService.ts";
import { ComputersLifecycle } from "../computers/ComputersLifecycle.ts";

const attributes = { "rpc.aggregate": "myComputer" };

export const MyComputerRpcLayer = WsMyComputerRpcGroup.toLayer(
  Effect.gen(function* () {
    const myComputer = yield* MyComputerService;
    const chatImport = yield* ChatImportService;
    const lifecycle = yield* ComputersLifecycle;
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
          // Removed: what it was for goes with it (CONTRACT.md §2).
          myComputer.disconnect(computerId).pipe(Effect.tap(() => lifecycle.forget(computerId))),
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
      [WS_METHODS.myComputerTrust]: (_input) =>
        observeRpcEffect(WS_METHODS.myComputerTrust, myComputer.trustState, attributes),
      [WS_METHODS.myComputerSetTrust]: (settings) =>
        observeRpcEffect(WS_METHODS.myComputerSetTrust, myComputer.setTrust(settings), attributes),
      [WS_METHODS.myComputerRevokeGrant]: ({ threadId, computerId }) =>
        observeRpcEffect(
          WS_METHODS.myComputerRevokeGrant,
          myComputer.revokeGrant({ threadId, computerId }),
          attributes,
        ),
      [WS_METHODS.myComputerStopAll]: (_input) =>
        observeRpcEffect(
          WS_METHODS.myComputerStopAll,
          myComputer.stopAll.pipe(
            // Disconnected: what each computer was for goes with it, as with Disconnect.
            Effect.tap(({ removed }) =>
              Effect.forEach(removed, (computerId) => lifecycle.forget(computerId), {
                discard: true,
              }),
            ),
            Effect.map(({ stopped, disconnected, failed }) => ({ stopped, disconnected, failed })),
          ),
          attributes,
        ),
      [WS_METHODS.myComputerResume]: (_input) =>
        observeRpcEffect(WS_METHODS.myComputerResume, myComputer.resume, attributes),
      [WS_METHODS.myComputerChatHistory]: ({ threadId }) =>
        observeRpcEffect(
          WS_METHODS.myComputerChatHistory,
          chatImport.history(threadId),
          attributes,
        ),
    });
  }),
);
