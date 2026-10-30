import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import "../../index.css";

import { useState } from "react";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const question = (id: string, multiSelect: boolean): UserInputQuestion => ({
  id,
  header: id,
  question: `Question ${id}`,
  options: [
    { label: `${id} one`, description: "" },
    { label: `${id} two`, description: "" },
  ],
  multiSelect,
});

const PROMPT = {
  requestId: ApprovalRequestId.make("request-1"),
  createdAt: "2026-10-30T00:00:00.000Z",
  questions: [question("first", false), question("second", true), question("third", false)],
};

function Card(props: { onAdvance: (index: number) => void }) {
  const [questionIndex, setQuestionIndex] = useState(0);
  return (
    <ComposerPendingUserInputPanel
      pendingUserInputs={[PROMPT]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={questionIndex}
      onToggleOption={() => undefined}
      onAdvance={() => {
        props.onAdvance(questionIndex);
        setQuestionIndex((index) => index + 1);
      }}
    />
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("treats each question by its own kind, not the first one's", async () => {
    const onAdvance = vi.fn();
    await render(<Card onAdvance={onAdvance} />);

    // A single choice moves on by itself.
    await page.getByRole("button", { name: /first one/ }).click();
    await expect.element(page.getByText("Question second")).toBeVisible();
    expect(onAdvance).toHaveBeenCalledTimes(1);

    // Several choices: the person picks, nothing moves or sends.
    await page.getByRole("button", { name: /second one/ }).click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onAdvance).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText("Question second")).toBeVisible();
  });
});
