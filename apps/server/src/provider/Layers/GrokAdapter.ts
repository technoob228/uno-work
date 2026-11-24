/**
 * GrokAdapter — xAI's Grok CLI (`grok agent stdio`) as a Uno Work agent. The
 * adapter is the shared {@link makeAcpAgentAdapter}; this file is only
 * Grok's launch profile (GrokAcpSupport): the binary from Settings → AI, the
 * chat's own folder, `--permission-mode default` so every edit and command
 * comes to Uno Work for an answer, a sign-in check before start (Grok would
 * wait forever on a missing one), the sign-in or API key to authenticate
 * with, a start deadline and a `session/load` deadline.
 *
 * @module GrokAdapter
 */
import { type GrokSettings, ProviderDriverKind } from "@t3tools/contracts";

import { resolveHarnessExecutable } from "../acp/CustomAcpSupport.ts";
import {
  GROK_ACP_ARGS,
  GROK_CANCEL_META,
  GROK_DRIVER_KIND,
  GROK_INITIALIZE_META,
  GROK_SESSION_LOAD_TIMEOUT_MS,
  GROK_SIGN_IN_HINT,
  GROK_START_TIMEOUT_MS,
  grokAuthMethodFor,
  grokAutoApprove,
  grokPreflight,
} from "../acp/GrokAcpSupport.ts";
import {
  type AcpAgentAdapterOptions,
  type AcpAgentAdapterShape,
  type AcpAgentProfile,
  makeAcpAgentAdapter,
} from "./AcpAgentAdapter.ts";

export type GrokAdapterShape = AcpAgentAdapterShape;
export type GrokAdapterOptions = AcpAgentAdapterOptions;

export function grokProfile(settings: Pick<GrokSettings, "binaryPath">): AcpAgentProfile {
  const binary = settings.binaryPath.trim() || "grok";
  return {
    provider: ProviderDriverKind.make(GROK_DRIVER_KIND),
    resolveCwd: (threadCwd) => threadCwd,
    resolveLaunch: async (env) => {
      const executable = await resolveHarnessExecutable(binary, env);
      return executable.ok
        ? { ok: true, command: executable.path, args: GROK_ACP_ARGS }
        : { ok: false, reason: executable.reason };
    },
    launchFailureHint: "Install Grok from Settings → AI.",
    authMethodId: grokAuthMethodFor,
    initializeMeta: { ...GROK_INITIALIZE_META },
    cancelMeta: { ...GROK_CANCEL_META },
    sessionLoadTimeoutMs: GROK_SESSION_LOAD_TIMEOUT_MS,
    preflight: grokPreflight,
    startTimeoutMs: GROK_START_TIMEOUT_MS,
    startTimeoutMessage: `Grok did not start in time. If its sign-in has expired: ${GROK_SIGN_IN_HINT}`,
    autoApprove: grokAutoApprove,
  };
}

export function makeGrokAdapter(settings: GrokSettings, options: GrokAdapterOptions) {
  return makeAcpAgentAdapter(grokProfile(settings), options);
}
