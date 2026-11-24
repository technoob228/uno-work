/**
 * AntigravityAdapter — Google Antigravity's official ACP agent (`agy acp`)
 * as a Uno Work agent. The adapter is the shared {@link makeAcpAgentAdapter};
 * this file is Antigravity's profile (AntigravityAcpSupport, ported from
 * upstream T3 Code):
 *
 *   - the runtime from Settings → AI, the one Uno Work installed, or the
 *     computer's own `agy` (AntigravityInstallation);
 *   - the computer's own Antigravity sign-in: the file on Linux, the
 *     keyring on a Mac or Windows unless the sign-in was made in Uno Work;
 *     a Gemini API key from Settings wins;
 *   - `clientInfo` by version (older runtimes open all models only to Zed);
 *   - sessions stay in agy's `default` mode and Uno Work answers its
 *     prompts by the chat's permission mode; uno-work tools need no card;
 *   - its questions (`interaction_*`) become question cards;
 *   - its `update_steps` checklist becomes the plan, tool payloads are
 *     bounded, thinking levels are a model option.
 *
 * @module AntigravityAdapter
 */
import { execFile } from "node:child_process";

import { type AntigravitySettings, ProviderDriverKind } from "@t3tools/contracts";

import {
  ANTIGRAVITY_ACP_ARGS,
  ANTIGRAVITY_DRIVER_KIND,
  ANTIGRAVITY_SESSION_LOAD_TIMEOUT_MS,
  ANTIGRAVITY_SIGN_IN_HINT,
  ANTIGRAVITY_START_TIMEOUT_MS,
  antigravityAuthMethodFor,
  antigravityAutoApprove,
  antigravityClientInfo,
  antigravityCredentialStore,
  antigravityModeFor,
  antigravityPreflight,
  antigravityProcessEnvironment,
  antigravityRefusePrompt,
  extractAntigravityUserInputQuestion,
  findLinuxCaBundle,
  isAntigravityVersionSupported,
  makeAntigravitySessionUpdateTransform,
  makeAntigravityUserInputResponse,
  planAntigravityModelSelection,
} from "../acp/AntigravityAcpSupport.ts";
import { resolveAntigravityExecutable } from "../AntigravityInstallation.ts";
import {
  type AcpAgentAdapterOptions,
  type AcpAgentAdapterShape,
  type AcpAgentProfile,
  makeAcpAgentAdapter,
} from "./AcpAgentAdapter.ts";

export type AntigravityAdapterShape = AcpAgentAdapterShape;
export type AntigravityAdapterOptions = AcpAgentAdapterOptions;

const versionCache = new Map<string, Promise<string | undefined>>();

/** `agy --version` of one file, once per daemon (a new install has a new path). */
export function antigravityVersionOf(
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  let cached = versionCache.get(executable);
  if (!cached) {
    cached = new Promise((resolve) => {
      execFile(
        executable,
        ["--version"],
        { env, timeout: 15_000, windowsHide: true },
        (error, stdout, stderr) => {
          const text = `${String(stdout)}\n${String(stderr)}`;
          const match = /\d+\.\d+\.\d+/.exec(text);
          if (error && !match) {
            versionCache.delete(executable);
            return resolve(undefined);
          }
          resolve(match?.[0]);
        },
      );
    });
    versionCache.set(executable, cached);
  }
  return cached;
}

export function antigravityProfile(
  settings: Pick<AntigravitySettings, "binaryPath">,
  options: { readonly clientVersion?: string } = {},
): AcpAgentProfile {
  return {
    provider: ProviderDriverKind.make(ANTIGRAVITY_DRIVER_KIND),
    resolveCwd: (threadCwd) => threadCwd,
    resolveLaunch: async (env) => {
      const executable = await resolveAntigravityExecutable({
        binaryPath: settings.binaryPath,
        env,
      });
      if (!executable.ok) return { ok: false, reason: executable.reason };
      const version = await antigravityVersionOf(executable.path, env);
      if (!isAntigravityVersionSupported(version)) {
        return {
          ok: false,
          reason: `Antigravity ${version} is too old for chats (1.5 or newer is needed).`,
        };
      }
      const store = await antigravityCredentialStore(env);
      const caBundlePath = await findLinuxCaBundle(env);
      return {
        ok: true,
        command: executable.path,
        args: ANTIGRAVITY_ACP_ARGS,
        environment: antigravityProcessEnvironment(env, {
          store,
          ...(caBundlePath ? { caBundlePath } : {}),
        }),
        clientInfo: antigravityClientInfo(version, options.clientVersion ?? "0.0.0"),
      };
    },
    launchFailureHint: "Install it from Settings → AI → Antigravity.",
    authMethodId: async (env) => antigravityAuthMethodFor(env),
    sessionLoadTimeoutMs: ANTIGRAVITY_SESSION_LOAD_TIMEOUT_MS,
    preflight: antigravityPreflight,
    startTimeoutMs: ANTIGRAVITY_START_TIMEOUT_MS,
    startTimeoutMessage: `Antigravity did not start in time. If its sign-in has expired: ${ANTIGRAVITY_SIGN_IN_HINT}`,
    modeFor: antigravityModeFor,
    autoApprove: antigravityAutoApprove,
    refusePrompt: antigravityRefusePrompt,
    makeSessionUpdateTransform: makeAntigravitySessionUpdateTransform,
    planModel: planAntigravityModelSelection,
    userInputQuestion: extractAntigravityUserInputQuestion,
    userInputResponse: makeAntigravityUserInputResponse,
  };
}

export function makeAntigravityAdapter(
  settings: AntigravitySettings,
  options: AntigravityAdapterOptions,
) {
  return makeAcpAgentAdapter(
    antigravityProfile(
      settings,
      options.clientVersion ? { clientVersion: options.clientVersion } : {},
    ),
    options,
  );
}
