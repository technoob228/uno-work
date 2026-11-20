/**
 * GeminiAdapter — Google's Gemini CLI (`gemini --acp`) as a Uno Work agent.
 * The adapter is the shared {@link makeAcpAgentAdapter} (the same one custom
 * harnesses run on); this file is only Gemini's launch profile: the binary
 * from Settings → AI, the chat's own folder, a sign-in check before start,
 * a start deadline, Gemini's modes kept to the ones where every edit and
 * command comes to Uno Work for an answer (GeminiAcpSupport).
 *
 * @module GeminiAdapter
 */
import { type GeminiSettings, ProviderDriverKind } from "@t3tools/contracts";

import { resolveHarnessExecutable } from "../acp/CustomAcpSupport.ts";
import {
  GEMINI_ACP_ARGS,
  GEMINI_DRIVER_KIND,
  GEMINI_SIGN_IN_HINT,
  GEMINI_START_TIMEOUT_MS,
  geminiAutoApprove,
  geminiModeFor,
  geminiPreflight,
} from "../acp/GeminiAcpSupport.ts";
import {
  type AcpAgentAdapterOptions,
  type AcpAgentAdapterShape,
  type AcpAgentProfile,
  makeAcpAgentAdapter,
} from "./AcpAgentAdapter.ts";

export type GeminiAdapterShape = AcpAgentAdapterShape;
export type GeminiAdapterOptions = AcpAgentAdapterOptions;

export function geminiProfile(settings: Pick<GeminiSettings, "binaryPath">): AcpAgentProfile {
  const binary = settings.binaryPath.trim() || "gemini";
  return {
    provider: ProviderDriverKind.make(GEMINI_DRIVER_KIND),
    resolveCwd: (threadCwd) => threadCwd,
    resolveLaunch: async (env) => {
      const executable = await resolveHarnessExecutable(binary, env);
      return executable.ok
        ? { ok: true, command: executable.path, args: GEMINI_ACP_ARGS }
        : { ok: false, reason: executable.reason };
    },
    launchFailureHint: "Install Gemini CLI from Settings → AI.",
    preflight: geminiPreflight,
    startTimeoutMs: GEMINI_START_TIMEOUT_MS,
    startTimeoutMessage: `Gemini CLI did not start in time. If it is waiting for a sign-in: ${GEMINI_SIGN_IN_HINT}`,
    modeFor: geminiModeFor,
    autoApprove: geminiAutoApprove,
  };
}

export function makeGeminiAdapter(settings: GeminiSettings, options: GeminiAdapterOptions) {
  return makeAcpAgentAdapter(geminiProfile(settings), options);
}
