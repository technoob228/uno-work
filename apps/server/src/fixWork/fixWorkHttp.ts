/**
 * `POST /api/fix-work/prepare`: the folder a Fix Work chat reads. The playbook,
 * this computer's facts and a tail of the log, with secrets taken out, written
 * by the daemon so the agent doesn't need the raw files. Only the owner: a
 * shared computer's guest has no business reading its logs.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { UNO_OPENCODE_VERSION } from "@t3tools/shared/agentVersions";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import { respondToAuthError } from "../auth/http.ts";
import { AuthError, ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { FIX_WORK_PLAYBOOK } from "./fixWorkPlaybook.ts";
import { buildFixWorkContext, redactForSupport, type FixWorkFacts } from "./fixWorkReport.ts";

const LOG_TAIL_BYTES = 256 * 1024;
/** Old folders go when a new one is made: logs shouldn't pile up. */
const KEEP_RUNS = 3;

async function readTail(path: string, bytes: number): Promise<string> {
  const file = await fsp.open(path, "r").catch(() => null);
  if (!file) return "";
  try {
    const { size } = await file.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // The first line of a tail is usually cut in half.
    return size > bytes ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await file.close();
  }
}

async function diskOf(path: string): Promise<FixWorkFacts["disk"]> {
  const stats = await fsp.statfs(path).catch(() => null);
  if (!stats) return null;
  const gb = (blocks: number) => Math.round((blocks * stats.bsize) / 1024 ** 3);
  return { freeGb: gb(stats.bavail), totalGb: gb(stats.blocks) };
}

async function dropOldRuns(root: string): Promise<void> {
  const runs = await fsp.readdir(root).catch(() => [] as string[]);
  const old = runs.toSorted().toReversed().slice(KEEP_RUNS);
  await Promise.all(
    old.map((name) => fsp.rm(nodePath.join(root, name), { recursive: true, force: true })),
  );
}

export const fixWorkPrepareRouteLayer = HttpRouter.add(
  "POST",
  "/api/fix-work/prepare",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    if (session.role !== "owner") {
      return yield* new AuthError({
        message: "Only the owner of this computer can run Fix Work.",
        status: 403,
      });
    }
    const config = yield* ServerConfig;
    const registry = yield* ProviderRegistry;
    const traces = yield* TraceDiagnostics.make;
    const providers = yield* registry.getProviders;
    const failures = yield* traces
      .read({ traceFilePath: config.serverTracePath, maxFiles: config.traceMaxFiles })
      .pipe(Effect.orElseSucceed(() => null));

    const now = new Date();
    const facts: FixWorkFacts = {
      generatedAt: now.toISOString(),
      version: packageJson.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      mode: config.mode,
      host: os.hostname(),
      memory: {
        freeMb: Math.round(os.freemem() / 1024 ** 2),
        totalMb: Math.round(os.totalmem() / 1024 ** 2),
      },
      disk: yield* Effect.promise(() => diskOf(config.baseDir)),
      uptimeHours: Math.round(os.uptime() / 3600),
      paths: { daemonFolder: config.baseDir, workspace: config.cwd },
      openCodeVersion: UNO_OPENCODE_VERSION,
      agents: providers.map((provider) => ({
        name: provider.displayName ?? provider.instanceId,
        version: provider.version,
        status: provider.status,
        signedIn: provider.auth.status,
        message: provider.message ?? null,
      })),
    };

    const root = nodePath.join(config.stateDir, "fix-work");
    const folder = nodePath.join(root, now.toISOString().replace(/[:.]/g, "-"));
    const written = yield* Effect.tryPromise(async () => {
      await fsp.mkdir(folder, { recursive: true, mode: 0o700 });
      const write = (name: string, text: string) =>
        fsp.writeFile(nodePath.join(folder, name), text, { mode: 0o600 });
      const tail = await readTail(config.serverLogPath, LOG_TAIL_BYTES);
      await write("PLAYBOOK.md", FIX_WORK_PLAYBOOK);
      await write("context.md", buildFixWorkContext(facts));
      await write("server-log-tail.txt", redactForSupport(tail).text);
      await write(
        "recent-failures.json",
        redactForSupport(JSON.stringify(failures, null, 2) ?? "null").text,
      );
      await dropOldRuns(root);
    }).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logError("fix-work: could not prepare the folder", { cause: String(cause) }).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (!written) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Couldn't read this computer's logs. Try again in a minute." },
        { status: 500 },
      );
    }
    return HttpServerResponse.jsonUnsafe({
      playbookPath: nodePath.join(folder, "PLAYBOOK.md"),
    });
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);
