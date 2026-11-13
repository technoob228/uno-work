/**
 * Deploy-window requests (deployApprovals.logic.ts) as the window holds them:
 * the console's last answer, polled with the person's account session —
 * every 15 s while the window is visible, every minute behind other windows,
 * every 3 s for two minutes after "Открыть" (the person is in the browser
 * with Touch ID and comes back to see it open). A person who isn't an
 * approver, or an interface without the account (`accountTransport() ===
 * "none"`), asks once and stops.
 */
import { create } from "zustand";

import {
  AccountHttpError,
  AccountSignInRequiredError,
  accountRequest,
  accountTransport,
} from "../account/unoAccount";
import { openUntrustedLinkExternally } from "../lib/externalLinks";
import { toastManager } from "../components/ui/toast";
import {
  type DeployApprovals,
  type DeployRequest,
  NOT_AN_APPROVER,
  conflictMessage,
  parseDeployApprovals,
  waitingCount,
} from "./deployApprovals.logic";

const INBOX_PATH = "/api/v1/ops-gate/inbox";

interface DeployApprovalsState {
  /** null — not asked yet. */
  readonly gate: DeployApprovals | null;
  /** The console said no for good (not signed in, not this interface, no such route). */
  readonly stopped: boolean;
  /** Request id (or "freeze") being answered right now. */
  readonly busy: Readonly<Record<string, true>>;
  /** Poll fast until this time (ms). */
  readonly fastUntil: number;
}

export const useDeployApprovalsStore = create<DeployApprovalsState>(() => ({
  gate: null,
  stopped: false,
  busy: {},
  fastUntil: 0,
}));

/** Requests waiting for a decision — added to the bell's and the Inbox row's count. */
export function useDeployWaitingCount(): number {
  return useDeployApprovalsStore((state) => waitingCount(state.gate));
}

let inFlight: Promise<DeployApprovals | null> | null = null;

/** Ask the console now; the previous answer is kept on a passing error. */
export function refreshDeployApprovals(): Promise<DeployApprovals | null> {
  if (inFlight) return inFlight;
  const run = async (): Promise<DeployApprovals | null> => {
    if (accountTransport() === "none") {
      useDeployApprovalsStore.setState({ gate: NOT_AN_APPROVER, stopped: true });
      return null;
    }
    try {
      const gate = parseDeployApprovals(await accountRequest("GET", INBOX_PATH));
      useDeployApprovalsStore.setState({ gate, stopped: !gate.approver });
      return gate;
    } catch (cause) {
      const status = cause instanceof AccountHttpError ? cause.status : 0;
      // 403 — not the person's own interface session (an operator, an agent
      // key); 404 — a console without the gate. Signed out — the same.
      if (status === 403 || status === 404 || cause instanceof AccountSignInRequiredError) {
        useDeployApprovalsStore.setState({ gate: NOT_AN_APPROVER, stopped: true });
      }
      return null;
    }
  };
  inFlight = run().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** How long until the next poll (ms). */
export function nextPollDelay(input: {
  readonly visible: boolean;
  readonly nowMs: number;
  readonly fastUntil: number;
}): number {
  if (input.nowMs < input.fastUntil) return 3_000;
  return input.visible ? 15_000 : 60_000;
}

function setBusy(key: string, on: boolean): void {
  useDeployApprovalsStore.setState((state) => {
    if (on) return { busy: { ...state.busy, [key]: true } };
    const { [key]: _done, ...rest } = state.busy;
    return { busy: rest };
  });
}

async function answer(
  key: string,
  path: string,
  failTitle: string,
  doneTitle: string,
): Promise<void> {
  setBusy(key, true);
  try {
    const out = await accountRequest("POST", path);
    toastManager.add({ type: "success", title: conflictMessage(out) ?? doneTitle });
  } catch (cause) {
    if (cause instanceof AccountHttpError && cause.status === 409) {
      // Someone already decided (in Telegram, or the window ran out).
      toastManager.add({
        type: "info",
        title: conflictMessage(cause.body) ?? "Уже решено",
      });
    } else {
      toastManager.add({
        type: "error",
        title: failTitle,
        description: cause instanceof Error ? cause.message : "Консоль не ответила.",
      });
    }
  } finally {
    setBusy(key, false);
    await refreshDeployApprovals();
  }
}

export function denyDeployRequest(request: DeployRequest): Promise<void> {
  return answer(
    String(request.id),
    `${INBOX_PATH}/${request.id}/deny`,
    "Не получилось отказать",
    "Отказано",
  );
}

export function closeDeployWindow(request: DeployRequest): Promise<void> {
  return answer(
    String(request.id),
    `${INBOX_PATH}/${request.id}/close`,
    "Не получилось закрыть окно",
    "Окно закрыто",
  );
}

export function freezeDeploys(): Promise<void> {
  return answer("freeze", `${INBOX_PATH}/freeze`, "Не получилось заморозить", "Всё заморожено");
}

/**
 * "Открыть на N мин": the console's Touch ID page in the system browser (a
 * new tab on the web). The card itself never opens a window.
 */
export function openDeployApprovalPage(request: DeployRequest): boolean {
  if (!request.approveUrl) return false;
  const opened = openUntrustedLinkExternally(request.approveUrl);
  if (opened) useDeployApprovalsStore.setState({ fastUntil: Date.now() + 2 * 60_000 });
  return opened;
}
