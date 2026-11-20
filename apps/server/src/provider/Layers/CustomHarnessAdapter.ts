/**
 * CustomHarnessAdapter — any ACP agent (a custom harness) as a Uno Work
 * provider; contract in docs/custom-harness.md. The adapter itself is the
 * shared {@link makeAcpAgentAdapter}: here only what the person configured
 * (command, argv, working folder, auth method) becomes its launch profile.
 *
 * @module CustomHarnessAdapter
 */
import {
  CUSTOM_HARNESS_DRIVER_KIND,
  type CustomHarnessSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { validateHarnessConfig } from "@t3tools/shared/customHarness";

import { resolveHarnessCwd, resolveHarnessExecutable } from "../acp/CustomAcpSupport.ts";
import {
  type AcpAgentAdapterOptions,
  type AcpAgentAdapterShape,
  type AcpAgentProfile,
  makeAcpAgentAdapter,
} from "./AcpAgentAdapter.ts";

export type CustomHarnessAdapterShape = AcpAgentAdapterShape;
export type CustomHarnessAdapterOptions = AcpAgentAdapterOptions;

export function customHarnessProfile(settings: CustomHarnessSettings): AcpAgentProfile {
  const authMethodId = settings.authMethodId.trim();
  return {
    provider: ProviderDriverKind.make(CUSTOM_HARNESS_DRIVER_KIND),
    resolveCwd: (threadCwd) => resolveHarnessCwd(settings, threadCwd),
    resolveLaunch: async (env) => {
      const valid = validateHarnessConfig(settings);
      if (!valid.ok) return { ok: false, reason: valid.reason };
      const executable = await resolveHarnessExecutable(settings.command, env);
      return executable.ok
        ? { ok: true, command: executable.path, args: settings.args }
        : { ok: false, reason: executable.reason };
    },
    launchFailureHint: "Install it or fix the command in Settings → Harnesses.",
    ...(authMethodId ? { authMethodId } : {}),
  };
}

export function makeCustomHarnessAdapter(
  settings: CustomHarnessSettings,
  options: CustomHarnessAdapterOptions,
) {
  return makeAcpAgentAdapter(customHarnessProfile(settings), options);
}
