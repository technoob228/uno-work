/**
 * "Fix Work": the daemon writes a folder with the playbook, this computer's
 * facts and a cleaned tail of the log (apps/server/src/fixWork/), and a new chat
 * in Ask mode follows it. The chat is the whole interface, so everything the
 * agent does is on screen and each command waits for the person's Allow.
 */
import type { EnvironmentId, RuntimeMode } from "@t3tools/contracts";

import { environmentFetchJson, isEnvironmentHttpError } from "../environments/http/target";

/** Each command waits for Allow: the boundary the playbook can't draw by itself. */
export const FIX_WORK_RUNTIME_MODE: RuntimeMode = "approval-required";

export const FIX_WORK_COPY = {
  menu: "Fix Work…",
  title: "Fix Work",
  description:
    "Tell Uno what went wrong. It reads this computer's logs, tries safe fixes and writes a letter to support if a person needs to look.",
  placeholder: "The chat stopped answering after I…",
  promises: [
    "You approve every command.",
    "It leaves your keys and other chats alone.",
    "The letter stays a draft. You send it yourself.",
  ],
  start: "Start fixing",
  starting: "Getting ready…",
  cancel: "Cancel",
  needsUpdate: "Update Uno Work on this computer first, then try again.",
  failed: "Couldn't read this computer's logs. Try again in a minute.",
} as const;

export function fixWorkPrompt(problem: string, playbookPath: string): string {
  const what = problem.trim() || "I'm not sure yet. Ask me.";
  return `Fix Work. What went wrong: ${what}\n\nFollow the steps in ${playbookPath}`;
}

/** The person's own words: the line for the agent stays out of their bubble. */
export function fixWorkVisibleText(text: string): string {
  return text.replace(/^(Fix Work\. [\s\S]*?)\n\nFollow the steps in \S+$/, "$1");
}

export async function prepareFixWork(environmentId: EnvironmentId): Promise<string> {
  try {
    const { playbookPath } = await environmentFetchJson<{ playbookPath: string }>({
      environmentId,
      pathname: "/api/fix-work/prepare",
      method: "POST",
      body: {},
    });
    return playbookPath;
  } catch (error) {
    if (isEnvironmentHttpError(error) && error.status === 404) {
      throw new Error(FIX_WORK_COPY.needsUpdate);
    }
    throw new Error(FIX_WORK_COPY.failed);
  }
}
