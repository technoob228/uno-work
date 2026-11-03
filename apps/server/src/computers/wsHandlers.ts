/**
 * The web socket's computers lifecycle methods (contracts computers.ts). Their
 * own group and layer (see WsComputersRpcGroup): ws.ts serves them next to the
 * main group.
 */
import { WS_METHODS, WsComputersRpcGroup } from "@t3tools/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { ComputersLifecycle } from "./ComputersLifecycle.ts";

const attributes = { "rpc.aggregate": "computers" };

export const ComputersRpcLayer = WsComputersRpcGroup.toLayer(
  Effect.gen(function* () {
    const computers = yield* ComputersLifecycle;
    return WsComputersRpcGroup.of({
      [WS_METHODS.computersState]: (_input) =>
        observeRpcEffect(WS_METHODS.computersState, computers.state, attributes),
      [WS_METHODS.computersSetPurpose]: ({ computerId, purpose }) =>
        observeRpcEffect(
          WS_METHODS.computersSetPurpose,
          computers.setPurpose(computerId, purpose),
          attributes,
        ),
      [WS_METHODS.computersWorkStatus]: ({ computerId }) =>
        observeRpcEffect(
          WS_METHODS.computersWorkStatus,
          computers.workStatus(computerId),
          attributes,
        ),
      [WS_METHODS.computersWorkScan]: ({ computerId }) =>
        observeRpcEffect(WS_METHODS.computersWorkScan, computers.workScan(computerId), attributes),
      [WS_METHODS.computersBringWork]: (input) =>
        observeRpcEffect(WS_METHODS.computersBringWork, computers.bringWork(input), attributes),
      [WS_METHODS.computersOpenFolder]: (input) =>
        observeRpcEffect(WS_METHODS.computersOpenFolder, computers.openFolder(input), attributes),
      [WS_METHODS.computersContinueInCloud]: (input) =>
        observeRpcEffect(
          WS_METHODS.computersContinueInCloud,
          computers.continueInCloud(input),
          attributes,
        ),
    });
  }),
);
