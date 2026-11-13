/**
 * A chat's question, answerable where it is shown (the Needs-you screen):
 * like `usePendingApproval`, keeps the chat's details subscribed while
 * mounted (only the chat's own events carry the question and its options)
 * and sends the same `thread.user-input.respond` the chat's own card sends.
 * Only a single question with ready options is answered here; anything more
 * (several questions, a field to fill, files) opens the chat.
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ThreadId, UserInputQuestion } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { retainThreadDetailSubscription } from "../environments/runtime/service";
import { newCommandId } from "../lib/utils";
import { derivePendingUserInputs } from "../session-logic";
import { createThreadSelectorByRef } from "../storeSelectors";
import { useStore } from "../store";

export interface PendingQuestionState {
  /** The one question with options, or null (not known yet, or the chat has to open). */
  readonly question: UserInputQuestion | null;
  readonly responding: boolean;
  readonly answer: (option: string) => Promise<boolean>;
}

export function usePendingQuestion(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): PendingQuestionState {
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  useEffect(
    () => retainThreadDetailSubscription(environmentId, threadId),
    [environmentId, threadId],
  );
  const detail = useStore(useMemo(() => createThreadSelectorByRef(ref), [ref]));
  const pending = useMemo(
    () => (detail ? (derivePendingUserInputs(detail.activities)[0] ?? null) : null),
    [detail],
  );
  const only = pending?.questions.length === 1 ? pending.questions[0] : undefined;
  const question =
    only && only.options.length > 0 && !only.multiSelect && !only.input ? only : null;
  const [responding, setResponding] = useState(false);
  const answer = async (option: string) => {
    if (!pending || !question) return false;
    const api = readEnvironmentApi(environmentId);
    if (!api) return false;
    setResponding(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.user-input.respond",
        commandId: newCommandId(),
        threadId,
        requestId: pending.requestId,
        answers: { [question.id]: option },
        createdAt: new Date().toISOString(),
      });
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't send your answer",
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setResponding(false);
    }
  };
  return { question, responding, answer };
}
