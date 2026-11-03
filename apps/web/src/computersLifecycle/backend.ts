/**
 * Computers lifecycle: what isn't a `computers.*` RPC — the console (deleting
 * or turning off a cloud computer), and the desktop app setting this Mac up by
 * itself. In the demo (`demo/assist/lifecycle.ts`) `demoHooks.lc` answers these
 * too; the RPCs themselves are answered by the demo's daemon.
 */
import type {
  DesktopConnectHelperState,
  EnvironmentId,
  MyComputerPairStatus,
} from "@t3tools/contracts";

import { AccountHttpError, accountRequest } from "../account/unoAccount";
import { demoHooks } from "../demo/demoFlag";
import { ensureEnvironmentApi } from "../environmentApi";

export interface LifecycleDemoHooks {
  /** The person pressed Download or copied the command: the helper comes up in a moment. */
  installStarted(): void;
  /** The desktop app makes this Mac one of the computers. Resolves with its id. */
  installHere(): Promise<string>;
  /** The desktop app: Uno's helper on this Mac. */
  thisMacHelper(): DesktopConnectHelperState;
  deleteBox(boxId: number): Promise<void>;
  sleepBox(boxId: number): Promise<void>;
}

function demo(): Partial<LifecycleDemoHooks> {
  return (demoHooks.lc ?? {}) as Partial<LifecycleDemoHooks>;
}

/** Why deleting a cloud computer from here didn't happen (CONTRACT.md §4.2). */
export type DeleteRefusal = "last-on-plan" | null;

export function deleteRefusal(cause: unknown): DeleteRefusal {
  if (!(cause instanceof AccountHttpError)) return null;
  if (cause.status === 409 && /LAST_COMPUTER_ON_PLAN/.test(cause.message)) return "last-on-plan";
  return null;
}

const PAIR_WAIT_MS = 90_000;
const PAIR_POLL_MS = 1_500;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function desktopHelper() {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.connectHelper;
}

const NO_HELPER: DesktopConnectHelperState = { installed: false, computerId: null, name: null };

export const lifecycleBackend = {
  thisMacHelper: async (): Promise<DesktopConnectHelperState> => {
    const hook = demo().thisMacHelper;
    if (hook) return hook();
    return (await desktopHelper()?.state()) ?? NO_HELPER;
  },
  installStarted: () => demo().installStarted?.(),
  /** This app can set this computer up by itself (the desktop app). */
  canInstallHere: () => demo().installHere !== undefined || desktopHelper() !== undefined,
  /**
   * The desktop app: a code from the cloud computer, the helper downloaded,
   * checked and paired here by the app's main process; then the pairing's
   * answer names the new computer.
   */
  installHere: async (hostId: EnvironmentId): Promise<string> => {
    const hook = demo().installHere;
    if (hook) return hook();
    const helper = desktopHelper();
    if (!helper) throw new Error("Only the Uno Work app can do this.");
    const api = ensureEnvironmentApi(hostId).myComputer;
    const pairing = await api.pair();
    const installed = await helper.install({
      url: pairing.url,
      code: pairing.code,
      ...(pairing.api ? { api: pairing.api } : {}),
      ...(pairing.download ? { download: pairing.download } : {}),
    });
    if (!installed.ok) throw new Error(installed.message);
    const deadline = Date.now() + PAIR_WAIT_MS;
    let status: MyComputerPairStatus | null = null;
    while (Date.now() < deadline) {
      status = await api.pairStatus({ code: pairing.code }).catch(() => null);
      if (status?.state === "claimed" && status.computerId) return status.computerId;
      if (status?.state === "failed" || status?.state === "expired") break;
      await wait(PAIR_POLL_MS);
    }
    throw new Error(status?.message ?? "This Mac didn’t connect. Try again.");
  },
  deleteBox: async (boxId: number) => {
    const hook = demo().deleteBox;
    if (hook) return hook(boxId);
    await accountRequest("DELETE", `/api/v1/boxes/${boxId}`);
  },
  sleepBox: async (boxId: number) => {
    const hook = demo().sleepBox;
    if (hook) return hook(boxId);
    await accountRequest("POST", `/api/v1/boxes/${boxId}/sleep`, {});
  },
};
