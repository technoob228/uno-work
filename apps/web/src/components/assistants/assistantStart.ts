/**
 * The two things a new assistant's setup does on ITS computer straight from
 * the page (the page is connected to every computer of the account by its
 * environment id, so nothing goes through the cloud):
 *
 * - {@link saveLoginsToVault}: the account form's logins into the password
 *   vault of that computer (`vault.upsert` of its daemon). The password goes
 *   in the RPC request only; the answer is metadata without it. Nothing is
 *   kept in a store or a log.
 * - {@link sendFirstMessage}: the first message into its chat, as the person —
 *   in the chat's own runtime mode, so "Cautious" stays asks-first.
 */
import type { CredentialMetadata, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";

import { readEnvironmentConnection } from "../../environments/runtime";
import { newCommandId, newMessageId } from "../../lib/utils";
import { selectThreadByRef, useStore } from "../../store";
import { type AccountDraft, siteOf, vaultInputOf } from "./assistantJob.logic";

function connectionOf(environmentId: EnvironmentId) {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) throw new Error("That computer isn't connected right now.");
  return connection.client;
}

function hostOf(url: string): string | null {
  return siteOf(url);
}

/**
 * Saves each login into the vault of `environmentId`; an entry for the same
 * site and login is updated instead of doubled. Returns the saved entries
 * (no passwords).
 */
export async function saveLoginsToVault(
  environmentId: EnvironmentId,
  rows: ReadonlyArray<AccountDraft>,
): Promise<ReadonlyArray<CredentialMetadata>> {
  const client = connectionOf(environmentId);
  const existing = await client.vault.list().catch(() => [] as ReadonlyArray<CredentialMetadata>);
  const saved: CredentialMetadata[] = [];
  for (const row of rows) {
    const input = vaultInputOf(row);
    const same = existing.find(
      (entry) =>
        hostOf(entry.url) === hostOf(input.url) &&
        entry.username.toLowerCase() === input.username.toLowerCase(),
    );
    saved.push(await client.vault.upsert(same ? { id: same.id, input } : { input }));
  }
  return saved;
}

/** The person's message into the assistant's chat (the chat must be in the store). */
export async function sendFirstMessage(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
}): Promise<void> {
  const thread = selectThreadByRef(
    useStore.getState(),
    scopeThreadRef(input.environmentId, input.threadId),
  );
  if (!thread) throw new Error("Its chat isn't open yet.");
  await connectionOf(input.environmentId).orchestration.dispatchCommand({
    type: "thread.turn.start",
    commandId: newCommandId(),
    threadId: input.threadId,
    message: {
      messageId: newMessageId(),
      role: "user",
      text: input.text,
      attachments: [],
    },
    // The model stays the chat's own (its AI is the computer's choice).
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    createdAt: new Date().toISOString(),
  });
}
