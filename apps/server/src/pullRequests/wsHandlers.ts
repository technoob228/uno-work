/**
 * The web socket's pull request methods. Their own group and layer (see
 * WsPullRequestsRpcGroup): ws.ts serves them next to the main group.
 */
import { WS_METHODS, WsPullRequestsRpcGroup } from "@t3tools/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { ThreadPullRequests } from "../threadPullRequests/ThreadPullRequestService.ts";
import { PullRequests } from "./PullRequestService.ts";

const attributes = { "rpc.aggregate": "pull-requests" };

export const PullRequestsRpcLayer = WsPullRequestsRpcGroup.toLayer(
  Effect.gen(function* () {
    const pullRequests = yield* PullRequests;
    const threads = yield* ThreadPullRequests;
    return WsPullRequestsRpcGroup.of({
      [WS_METHODS.pullRequestsList]: (input) =>
        observeRpcEffect(WS_METHODS.pullRequestsList, pullRequests.list(input), attributes),
      [WS_METHODS.pullRequestsDetail]: (input) =>
        observeRpcEffect(WS_METHODS.pullRequestsDetail, pullRequests.detail(input), attributes),
      [WS_METHODS.pullRequestsDiff]: (input) =>
        observeRpcEffect(WS_METHODS.pullRequestsDiff, pullRequests.diff(input), attributes),
      [WS_METHODS.pullRequestsRunAction]: (input) =>
        observeRpcEffect(
          WS_METHODS.pullRequestsRunAction,
          pullRequests.runAction(input),
          attributes,
        ),
      [WS_METHODS.pullRequestsSetFileViewed]: (input) =>
        observeRpcEffect(
          WS_METHODS.pullRequestsSetFileViewed,
          pullRequests.setFileViewed(input),
          attributes,
        ),
      [WS_METHODS.pullRequestsComment]: (input) =>
        observeRpcEffect(WS_METHODS.pullRequestsComment, pullRequests.comment(input), attributes),
      [WS_METHODS.pullRequestsSetWatch]: (input) =>
        observeRpcEffect(WS_METHODS.pullRequestsSetWatch, threads.setWatch(input), attributes),
      [WS_METHODS.pullRequestsLink]: (input) =>
        observeRpcEffect(WS_METHODS.pullRequestsLink, threads.link(input), attributes),
      [WS_METHODS.pullRequestsUnlink]: (input) =>
        observeRpcEffect(WS_METHODS.pullRequestsUnlink, threads.unlink(input), attributes),
    });
  }),
);
