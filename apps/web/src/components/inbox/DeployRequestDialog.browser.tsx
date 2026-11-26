/**
 * T68: a deploy-window notification click shows the request's card with
 * both «Открыть» and «Отказать» at once — measured from the click (the
 * target is under 300 ms), without waiting for the console.
 */
import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fakeConsole = vi.hoisted(() => ({
  answers: [] as unknown[],
  posts: [] as string[],
  /** The console's GET waits this long (ms) — the click must not. */
  delayMs: 0,
}));

vi.mock("../../hooks/useFeatureFlags", () => ({ useFeatureFlag: () => true }));
import { DeployApprovalsListener } from "../../deployApprovals/DeployApprovalsListener";
import {
  refreshDeployApprovals,
  useDeployApprovalsStore,
} from "../../deployApprovals/deployApprovalsStore";

/** window.Notification as the desktop app has it: shown, then clicked by the person. */
class FakeNotification {
  static permission = "granted";
  static shown: FakeNotification[] = [];
  static requestPermission = async () => "granted";
  private readonly listeners: Array<() => void> = [];
  constructor(
    readonly title: string,
    readonly options: { body?: string },
  ) {
    FakeNotification.shown.push(this);
  }
  addEventListener(_type: "click", listener: () => void) {
    this.listeners.push(listener);
  }
  close() {}
  click() {
    for (const listener of this.listeners) listener();
  }
}

const gate = (requests: unknown[], extra: Record<string, unknown> = {}) => ({
  approver: true,
  frozen: false,
  web: false,
  passkeys: 0,
  requests,
  ...extra,
});
const waiting = {
  id: 132,
  machine: "box-395",
  summary: "T51 1/4 общий чат. env: WORK_TEAM",
  minutes: 25,
  status: "requested",
  kind: "critical",
  created_at: "2026-11-24T16:51:40Z",
  status_line: "⏳ ждёт решения",
};

async function notificationFor(answers: unknown[]): Promise<FakeNotification> {
  fakeConsole.answers = answers;
  await render(<DeployApprovalsListener />);
  // The first answer only sets the baseline; the next one brings the new request.
  await vi.waitFor(() => expect(useDeployApprovalsStore.getState().gate).not.toBeNull());
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(FakeNotification.shown.length).toBe(1));
  return FakeNotification.shown[0]!;
}

describe("DeployRequestDialog (T68)", () => {
  beforeEach(() => {
    FakeNotification.shown = [];
    fakeConsole.posts = [];
    fakeConsole.delayMs = 0;
    vi.stubGlobal("Notification", FakeNotification);
    // The desktop app's account bridge (Misha's Mac): what the console answers.
    (window as unknown as { desktopBridge: unknown }).desktopBridge = {
      unoAccount: {
        request: async (input: { method: string; path: string }) => {
          if (input.method === "POST") {
            fakeConsole.posts.push(input.path);
            return { status: 200, body: { ok: true, message: "Отказано" } };
          }
          await new Promise((resolve) => setTimeout(resolve, fakeConsole.delayMs));
          const body =
            fakeConsole.answers.length > 1 ? fakeConsole.answers.shift() : fakeConsole.answers[0];
          return { status: 200, body };
        },
      },
    };
    useDeployApprovalsStore.setState({ gate: null, stopped: false, focused: null, busy: {} });
  });
  afterEach(async () => {
    // The slow answer still on its way belongs to this test.
    await refreshDeployApprovals();
    vi.unstubAllGlobals();
    delete (window as unknown as { desktopBridge?: unknown }).desktopBridge;
  });

  it("a click shows the card with Allow and Deny at once, the console still answering", async () => {
    const notification = await notificationFor([gate([]), gate([waiting])]);
    expect(notification.title).toBe("Критичное: box-395 просит окно в прод");

    // The console is slow now (3 s): the card must not wait for it.
    fakeConsole.delayMs = 3_000;
    const started = performance.now();
    notification.click();
    const dialog = page.getByTestId("deploy-request-dialog");
    await expect.element(dialog.getByTestId("deploy-open-132")).toBeVisible();
    await expect.element(dialog.getByTestId("deploy-deny-132")).toBeVisible();
    const ms = Math.round(performance.now() - started);
    console.info(`[T68] notification click → card with Allow+Deny: ${ms} ms`);
    expect(ms).toBeLessThan(300);
    await expect.element(dialog.getByText("Разрешить на 25 мин")).toBeVisible();
  });

  it("Allow without Touch ID says what to press; Deny decides and closes", async () => {
    const notification = await notificationFor([gate([]), gate([waiting])]);
    notification.click();
    const dialog = page.getByTestId("deploy-request-dialog");
    await dialog.getByTestId("deploy-open-132").click();
    await expect.element(dialog.getByTestId("deploy-open-why-132")).toHaveTextContent(/Telegram/);
    await dialog.getByTestId("deploy-deny-132").click();
    await vi.waitFor(() => expect(fakeConsole.posts).toEqual(["/api/v1/ops-gate/inbox/132/deny"]));
    await expect.element(page.getByTestId("deploy-request-dialog")).not.toBeInTheDocument();
  });
});
