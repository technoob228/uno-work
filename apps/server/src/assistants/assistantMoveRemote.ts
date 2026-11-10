/**
 * `assistant_move` (uno-work MCP): the daemon moves one of ITS assistants to
 * another computer of the account — the same orchestration the app runs
 * (`@t3tools/shared/assistantMove`), with this computer as the source (its
 * own ops) and the other one reached through the console's pairing
 * (`remoteComputers/`), as an owner session there.
 *
 * Needs this computer to reach the others: the account key (a laptop) or a
 * machine token allowed to (Settings → Computer access); otherwise the error
 * says so and nothing changes.
 *
 * @module assistants/assistantMoveRemote
 */
import { ASSISTANT_PROJECT_ID, isAssistantProjectId } from "@t3tools/contracts";
import {
  type AssistantMoveActivateResult,
  type AssistantMoveAutomation,
  type AssistantMoveDeps,
  type AssistantMoveImportResult,
  type AssistantMoveListedAutomation,
  type AssistantMoveOutcome,
  describeAssistantMove,
  runAssistantMove,
  splitMovableAutomations,
} from "@t3tools/shared/assistantMove";
import { Effect, Option } from "effect";

import { AutomationsService } from "../automations/AutomationsService.ts";
import { ManagerAssistantService } from "../manager/Services/AssistantService.ts";
import { remoteErrorText } from "../remoteComputers/remoteDaemonClient.ts";
import { RemoteComputersService } from "../remoteComputers/RemoteComputers.ts";
import { ASSISTANT_MOVE_PATH } from "./assistantMoveHttp.ts";
import { AssistantMoveOpError, makeAssistantMoveOps } from "./assistantMoveOps.ts";

/** A bundle of up to ~65 MB crosses the internet: well past the usual 20 s. */
const BUNDLE_TIMEOUT_MS = 5 * 60_000;

export interface AssistantMoveRemoteResult extends AssistantMoveOutcome {
  readonly assistant: string;
  readonly from: string;
  readonly to: string;
  readonly toBoxId: number;
  readonly summary: string;
}

const fail = (message: string, status = 409) => new AssistantMoveOpError({ message, status });

/** `assistant`: a name, a project id, or nothing (Uno). */
export const resolveAssistantRef = (raw: string | null | undefined) =>
  Effect.gen(function* () {
    const assistants = yield* ManagerAssistantService;
    const list = yield* assistants
      .listAssistants()
      .pipe(Effect.mapError((error) => fail(error.detail, 500)));
    const wanted = raw?.trim().toLowerCase() ?? "";
    if (wanted.length === 0 || wanted === "uno") {
      const uno = list.find((item) => item.projectId === ASSISTANT_PROJECT_ID);
      if (uno === undefined) return yield* fail("Uno isn't set up on this computer.", 404);
      return { projectId: uno.projectId as string, name: "Uno" };
    }
    const found = list.filter(
      (item) =>
        item.projectId.toLowerCase() === wanted ||
        (isAssistantProjectId(wanted) ? false : item.title.trim().toLowerCase() === wanted) ||
        (item.team?.team.name ?? "").trim().toLowerCase() === wanted,
    );
    if (found.length !== 1) {
      const names = list.map((item) => item.team?.team.name || item.title).join(", ");
      return yield* fail(
        found.length === 0
          ? `There is no assistant "${raw}" on this computer. Here: ${names || "none"}.`
          : `Several assistants are called "${raw}"; pass its project id.`,
        404,
      );
    }
    const item = found[0]!;
    return {
      projectId: item.projectId as string,
      name: item.projectId === ASSISTANT_PROJECT_ID ? "Uno" : item.team?.team.name || item.title,
    };
  });

export const moveAssistantToOtherComputer = (input: {
  readonly assistant?: string | null | undefined;
  readonly computerId: unknown;
}) =>
  Effect.gen(function* () {
    const remote = yield* Effect.serviceOption(RemoteComputersService);
    if (Option.isNone(remote)) {
      return yield* fail("This Uno Work can't reach other computers.", 501);
    }
    const target = yield* remote.value
      .resolveTarget(input.computerId)
      .pipe(Effect.mapError((error) => fail(error.message, 409)));
    const who = yield* resolveAssistantRef(input.assistant);
    if (target.kind === "this") {
      return yield* fail(`${who.name} already lives on this computer.`, 409);
    }
    const self = yield* remote.value.self;
    const ops = yield* makeAssistantMoveOps;
    const automations = yield* Effect.serviceOption(AutomationsService);
    const context = yield* Effect.context<never>();
    const run = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.runPromiseWith(context)(
        effect.pipe(
          Effect.mapError((error) =>
            error instanceof Error
              ? error
              : new Error(String((error as { message?: unknown }).message ?? error)),
          ),
        ),
      );

    /** One call to the other daemon; any non-200 is an Error with its words. */
    const call = async <A>(
      path: string,
      body: unknown,
      timeoutMs?: number,
      method: "POST" | "DELETE" = "POST",
    ): Promise<A> => {
      const reply = await run(
        remote.value.request({
          boxId: target.boxId,
          computerName: target.name,
          method,
          path,
          body,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        }),
      );
      if (reply.status === 404 || reply.status === 405) {
        throw new Error(
          `Uno Work on ${target.name} is too old to take assistants; update it first`,
        );
      }
      if (reply.status < 200 || reply.status >= 300) {
        throw new Error(remoteErrorText(reply.body) ?? `HTTP ${reply.status}`);
      }
      return reply.body as A;
    };

    const from = { name: self.name, boxId: self.boxId };
    const to = { name: target.name, boxId: target.boxId };
    const deps: AssistantMoveDeps = {
      source: {
        exportBundle: (projectId) =>
          run(ops.exportBundle({ projectId, name: who.name, computerName: self.name })),
        release: (release) => run(ops.release(release)),
        unrelease: (projectId) => run(ops.unrelease(projectId)),
        ...(Option.isSome(automations)
          ? {
              listAutomations: async (projectId: string) => {
                const listed = await run(automations.value.list);
                return listed.available
                  ? splitMovableAutomations(
                      listed.automations as ReadonlyArray<AssistantMoveListedAutomation>,
                      projectId,
                    )
                  : { move: [] as AssistantMoveAutomation[], stay: [] as string[] };
              },
              deleteAutomation: (id: number) =>
                run(automations.value.remove(id)).then(() => undefined),
            }
          : {}),
      },
      target: {
        importBundle: (body) =>
          call<AssistantMoveImportResult>(`${ASSISTANT_MOVE_PATH}/import`, body, BUNDLE_TIMEOUT_MS),
        activate: (body) =>
          call<AssistantMoveActivateResult>(
            `${ASSISTANT_MOVE_PATH}/activate`,
            body,
            BUNDLE_TIMEOUT_MS,
          ),
        discard: (projectId) =>
          call(`${ASSISTANT_MOVE_PATH}/discard`, { projectId }).then(() => undefined),
        createAutomation: (body) => call<{ readonly id: number }>("/api/manager/automations", body),
        deleteAutomation: (id) =>
          call(`/api/manager/automations/${id}`, undefined, undefined, "DELETE").then(
            () => undefined,
          ),
      },
    };
    const outcome = yield* Effect.tryPromise({
      try: () => runAssistantMove({ projectId: who.projectId, name: who.name, from, to }, deps),
      catch: (cause) => fail(cause instanceof Error ? cause.message : String(cause), 409),
    });
    const result: AssistantMoveRemoteResult = {
      ...outcome,
      assistant: who.name,
      from: self.name,
      to: target.name,
      toBoxId: target.boxId,
      summary: describeAssistantMove(outcome, { name: who.name, from: self.name, to: target.name }),
    };
    return result;
  });
