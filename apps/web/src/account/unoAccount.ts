/**
 * The Uno account lives in the INTERFACE — the person signed in here — not on
 * a machine. Everything account-level (the list of computers, adding one,
 * waking or connecting one) goes from this interface to the console on the
 * person's behalf:
 *
 * - browser on app.uno4.work → same-origin `/_account/...`, served by the
 *   console itself with the person's entry session (HttpOnly cookie; no token
 *   ever reaches this page's JS). `X-Uno-Account` is the CSRF guard;
 * - desktop app → the main process, which holds the person's token from
 *   "Sign in with Uno" in the OS keychain (the renderer never sees it);
 * - anything else (a computer's own address, a self-hosted daemon in a
 *   browser) → not available here: open app.uno4.work instead.
 *
 * A machine never holds the account key; it has its own narrow identity.
 */
import type {
  UnoBoxConnection,
  UnoBoxCreateJobStatus,
  UnoCloudBoxPowerInput,
  UnoCloudConnectBoxInput,
  UnoCloudCreateBoxInput,
  UnoCloudCreateBoxResult,
  UnoCloudCreateBoxStatusInput,
  UnoCloudState,
} from "@t3tools/contracts";
import {
  ControlPlaneHttpError,
  asNullableString,
  asNumber,
  asString,
  parseUnoBoxConnection,
  parseUnoBoxList,
} from "@t3tools/shared/unoCloud";
import {
  isTerminalUnoBoxCreateJobState,
  runUnoBoxProvisionJob,
  type UnoBoxProvisionClient,
} from "@t3tools/shared/unoBoxProvision";

import { isWorkProxyHost } from "../hooks/useDirectMachineAddress";
import { isWebLite } from "../lite/flag";

export const UNO_WORK_URL = "https://app.uno4.work";

export type AccountTransport = "work-proxy" | "desktop" | "none";

export function accountTransport(): AccountTransport {
  if (typeof window === "undefined") return "none";
  if (window.desktopBridge?.unoAccount) return "desktop";
  if (isWorkProxyHost(window.location.hostname)) return "work-proxy";
  // The lite build is only ever served by app.uno4.work itself (same origin as
  // /_account), whatever name the host goes by.
  if (isWebLite) return "work-proxy";
  return "none";
}

export class AccountSignInRequiredError extends Error {
  constructor(message = "Sign in with Uno to see and add your computers.") {
    super(message);
    this.name = "AccountSignInRequiredError";
  }
}

export class AccountUnavailableError extends Error {
  constructor() {
    super("Your computers are managed at app.uno4.work or in the Uno Work app.");
    this.name = "AccountUnavailableError";
  }
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

function errorFrom(status: number, body: unknown): Error {
  if (status === 401) return new AccountSignInRequiredError();
  const detail =
    typeof body === "string" ? body : body && typeof body === "object" ? JSON.stringify(body) : "";
  return new ControlPlaneHttpError(
    status,
    detail ? `${status}: ${detail.slice(0, 200)}` : `HTTP ${status}`,
  );
}

/** One call to the console API as the signed-in person. */
export async function accountRequest(
  method: Method,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const transport = accountTransport();
  if (transport === "desktop") {
    const bridge = window.desktopBridge!.unoAccount!;
    const result = await bridge.request({ method, path, ...(body === undefined ? {} : { body }) });
    if (result.status < 200 || result.status >= 300) throw errorFrom(result.status, result.body);
    return result.body;
  }
  if (transport === "work-proxy") {
    const response = await fetch(`/_account${path}`, {
      method,
      credentials: "same-origin",
      headers: {
        "X-Uno-Account": "1",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    if (!response.ok) throw errorFrom(response.status, parsed);
    return parsed;
  }
  throw new AccountUnavailableError();
}

function disconnected(error: string | null): UnoCloudState {
  return { connected: false, account: null, boxes: [], fetchedAt: new Date().toISOString(), error };
}

async function loadState(): Promise<UnoCloudState> {
  if (accountTransport() === "none") return disconnected(null);
  let me: Record<string, unknown>;
  try {
    me = (await accountRequest("GET", "/auth/me")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AccountSignInRequiredError) return disconnected(null);
    return disconnected(error instanceof Error ? error.message : String(error));
  }
  let boxesError: string | null = null;
  const boxes = await accountRequest("GET", "/api/v1/boxes").then(parseUnoBoxList, (error) => {
    boxesError = error instanceof Error ? error.message : String(error);
    return [];
  });
  return {
    connected: true,
    account: {
      userId: asNumber(me["id"], -1),
      username: asString(me["username"]),
      email: asNullableString(me["email"]),
      balance: asNumber(me["balance"]),
      llmBalance: asNumber(me["llm_balance"]),
      role: asString(me["role"]) || "user",
    },
    boxes,
    fetchedAt: new Date().toISOString(),
    error: boxesError,
  };
}

const provisionClient: UnoBoxProvisionClient = {
  getWorkImage: () => accountRequest("GET", "/api/v1/work/image"),
  launchImage: (imageId, body) => accountRequest("POST", `/api/v1/images/${imageId}/launch`, body),
  createPlainBox: () =>
    Promise.reject(new Error("Uno Work computers are created from the Uno Work image only.")),
  getBox: (boxId) => accountRequest("GET", `/api/v1/boxes/${boxId}`),
  listPorts: (boxId) => accountRequest("GET", `/api/v1/boxes/${boxId}/ports`),
  openPort: (boxId, port) => accountRequest("POST", `/api/v1/boxes/${boxId}/ports`, { port }),
  createWorkSession: (boxId) => accountRequest("POST", `/api/v1/boxes/${boxId}/work/session`, {}),
  probeDaemonAddress: async (baseUrl) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${baseUrl}/.well-known/t3/environment`, {
        signal: controller.signal,
        cache: "no-store",
      }).finally(() => clearTimeout(timer));
      return response.ok;
    } catch {
      return false;
    }
  },
};

interface CreateJobRecord {
  readonly name: string;
  status: UnoBoxCreateJobStatus;
}
const createJobs = new Map<string, CreateJobRecord>();

/** Same shape as the daemon's `uno.cloud.*`, served by the interface's account. */
export const interfaceUnoCloud = {
  getState: (_input?: { readonly refresh?: boolean | undefined }): Promise<UnoCloudState> =>
    loadState(),
  boxPower: async (input: UnoCloudBoxPowerInput): Promise<UnoCloudState> => {
    await accountRequest("POST", `/api/v1/boxes/${input.boxId}/${input.action}`, {});
    return loadState();
  },
  connectBox: async (input: UnoCloudConnectBoxInput): Promise<UnoBoxConnection> => {
    const raw = await accountRequest("POST", `/api/v1/boxes/${input.boxId}/work/session`, {});
    const connection = parseUnoBoxConnection(raw, input.boxId);
    if (!connection) throw new Error("Uno did not return a link to this computer.");
    return connection;
  },
  createBox: async (input: UnoCloudCreateBoxInput): Promise<UnoCloudCreateBoxResult> => {
    const name = input.name.trim();
    if (!name) throw new Error("Give the computer a name.");
    for (const [jobId, record] of createJobs) {
      if (record.name === name && !isTerminalUnoBoxCreateJobState(record.status.state)) {
        return { jobId };
      }
    }
    const jobId = crypto.randomUUID();
    const record: CreateJobRecord = { name, status: { jobId, state: "creating" } };
    createJobs.set(jobId, record);
    void runUnoBoxProvisionJob(
      { jobId, name, ramMb: input.ramMb, vcpu: input.vcpu, diskGb: input.diskGb },
      {
        client: provisionClient,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        onStatus: (status) => {
          record.status = status;
        },
      },
    ).catch((cause: unknown) => {
      record.status = {
        jobId,
        state: "failed",
        message: cause instanceof Error ? cause.message : String(cause),
      };
    });
    return { jobId };
  },
  createBoxStatus: async (input: UnoCloudCreateBoxStatusInput): Promise<UnoBoxCreateJobStatus> => {
    const record = createJobs.get(input.jobId);
    if (!record) throw new Error("This computer is no longer being created here. Check the list.");
    return record.status;
  },
};
