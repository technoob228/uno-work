/**
 * `t3 chat start|send|status` — the same cross-computer chats for an agent
 * OUTSIDE Uno Work (Claude Code on a Mac, a script), with the account key in
 * `UNO_API_KEY`. No daemon needed on the caller's side.
 *
 *   UNO_API_KEY=… t3 chat start --computer cc-target --folder ~/projects/x "list ~/projects"
 *   t3 chat status box-2575:<id> --wait 120
 *   t3 chat send   box-2575:<id> "now do Y"
 *
 * Prints one JSON object. Sessions are cached per computer in
 * `~/.uno-work/remote-sessions.json` (0600) so each call does not sign in
 * anew (a sign-in is a device on that computer and a line in its journal).
 *
 * @module crossComputer/chatCli
 */
import type { RuntimeMode } from "@t3tools/contracts";
import { parseUnoBoxList } from "@t3tools/shared/unoCloud";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { fetchControlPlaneJson } from "../workspaceRegistry/unoCloudParse.ts";
import {
  formatRemoteThreadId,
  openRemoteSession,
  parseRemoteThreadId,
  readRemoteChat,
  RemoteSessionCache,
  RemoteWorkError,
  remoteChatUrl,
  resolveComputer,
  sendRemoteMessage,
  startRemoteChat,
  withRemoteSession,
  type RemoteWorkDeps,
  type RemoteWorkSession,
} from "./remoteWork.ts";

export type ChatCliInput =
  | {
      readonly action: "start";
      readonly computer: string;
      readonly text: string;
      readonly folder?: string | undefined;
      readonly title?: string | undefined;
      readonly model?: string | undefined;
      readonly from?: string | undefined;
      readonly waitSec?: number | undefined;
    }
  | {
      readonly action: "send";
      readonly threadId: string;
      readonly text: string;
      readonly from?: string | undefined;
      readonly waitSec?: number | undefined;
    }
  | {
      readonly action: "status";
      readonly threadId: string;
      readonly limit?: number | undefined;
      readonly waitSec?: number | undefined;
    };

export interface ChatCliDeps extends RemoteWorkDeps {
  readonly apiKey: string;
  readonly listComputers: () => Promise<
    ReadonlyArray<{ id: number; name: string; status: string }>
  >;
  readonly cache: RemoteSessionCache;
  readonly defaultFrom: string;
}

/** The outside caller holds the account key: its chats run as the person's own would. */
const CLI_RUNTIME_MODE: RuntimeMode = "full-access";

const MAX_WAIT_SEC = 600;

const waitMs = (sec: number | undefined) =>
  Math.min(MAX_WAIT_SEC, Math.max(0, Math.trunc(sec ?? 0))) * 1000;

export async function runChatCli(
  input: ChatCliInput,
  deps: ChatCliDeps,
): Promise<{ readonly exitCode: number; readonly output: Record<string, unknown> }> {
  if (deps.apiKey.trim().length === 0) {
    return {
      exitCode: 2,
      output: {
        ok: false,
        error: "no_key",
        message: "Set UNO_API_KEY to the Uno account api_key.",
      },
    };
  }
  const keyId = crypto.createHash("sha256").update(deps.apiKey).digest("hex").slice(0, 16);
  const from =
    input.action === "status" ? deps.defaultFrom : input.from?.trim() || deps.defaultFrom;
  const withBox = <T>(boxId: number, fn: (session: RemoteWorkSession) => Promise<T>) =>
    withRemoteSession(
      deps.cache,
      `${keyId}:${boxId}`,
      deps,
      () => openRemoteSession(deps, { boxId, clientLabel: `Agent: ${from}` }),
      fn,
    );

  try {
    if (input.action === "start") {
      const box = resolveComputer(await deps.listComputers(), input.computer);
      const { result, session } = await withBox(box.id, async (session) => ({
        session,
        result: await startRemoteChat(deps, session, {
          text: input.text,
          title: input.title,
          folder: input.folder,
          model: input.model,
          from,
          runtimeMode: CLI_RUNTIME_MODE,
        }),
      }));
      const threadId = formatRemoteThreadId(box.id, result.threadId);
      const output: Record<string, unknown> = {
        ok: true,
        threadId,
        computer: { id: box.id, name: box.name },
        folder: result.folder,
        title: result.title,
        url: remoteChatUrl(session, result.environmentId, result.threadId),
      };
      if (waitMs(input.waitSec) > 0) {
        output.chat = await withBox(box.id, (s) =>
          readRemoteChat(deps, s, result.threadId, { limit: 5, waitMs: waitMs(input.waitSec) }),
        );
      }
      return { exitCode: 0, output };
    }

    const remote = parseRemoteThreadId(input.threadId);
    if (remote === null) {
      return {
        exitCode: 2,
        output: {
          ok: false,
          error: "invalid_thread_id",
          message: 'Expected the threadId "box-<id>:<chat id>" that "chat start" printed.',
        },
      };
    }
    const box = resolveComputer(await deps.listComputers(), remote.boxId);
    if (input.action === "send") {
      await withBox(box.id, (session) =>
        sendRemoteMessage(deps, session, remote.threadId, {
          text: input.text,
          waitMs: waitMs(input.waitSec),
          from,
          runtimeMode: CLI_RUNTIME_MODE,
        }),
      );
      return {
        exitCode: 0,
        output: { ok: true, threadId: input.threadId, computer: { id: box.id, name: box.name } },
      };
    }
    const view = await withBox(box.id, (session) =>
      readRemoteChat(deps, session, remote.threadId, {
        limit: Math.min(100, Math.max(1, Math.trunc(input.limit ?? 20))),
        waitMs: waitMs(input.waitSec),
      }),
    );
    return {
      exitCode: 0,
      output: {
        ok: true,
        threadId: input.threadId,
        computer: { id: box.id, name: box.name },
        ...view,
      },
    };
  } catch (error) {
    const known = error instanceof RemoteWorkError;
    return {
      exitCode: 1,
      output: {
        ok: false,
        error: known ? error.code : "failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Sessions on disk, private to the user: `~/.uno-work/remote-sessions.json`. */
export function fileSessionCache(filePath: string): RemoteSessionCache {
  const readAll = (): Record<string, RemoteWorkSession> => {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, RemoteWorkSession>;
    } catch {
      return {};
    }
  };
  return new RemoteSessionCache({
    load: (key) => readAll()[key] ?? null,
    save: (key, session) => {
      const all = readAll();
      if (session === null) delete all[key];
      else all[key] = session;
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(filePath, JSON.stringify(all), { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    },
  });
}

/** Real network, the key from the environment. */
export function nodeChatCliDeps(env: NodeJS.ProcessEnv = process.env): ChatCliDeps {
  const apiKey = (env.UNO_API_KEY ?? "").trim();
  const controlPlane = (p: string, init?: RequestInit) => fetchControlPlaneJson(apiKey, p, init);
  return {
    apiKey,
    fetch: globalThis.fetch,
    controlPlane,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    listComputers: async () => parseUnoBoxList(await controlPlane("/api/v1/boxes")),
    cache: fileSessionCache(path.join(os.homedir(), ".uno-work", "remote-sessions.json")),
    defaultFrom: `an agent on ${os.hostname()}`,
  };
}
