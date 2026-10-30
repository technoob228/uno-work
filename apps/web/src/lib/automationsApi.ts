/**
 * Automations (28.10): an assistant's work on a schedule or on an event —
 * the daemon's `/api/manager/automations*` (it passes the console's answers
 * through). Contract: reports/day_2026-10-28/automations/CONTRACT.md.
 *
 * Errors come as `{error: {code, message, manageUrl?, connectUrl?}}` — with a
 * non-2xx status or (an older relay) a 2xx one; both turn into
 * {@link AutomationApiError} so the screens can offer the right button
 * ("Add it on GitHub", "Connect GitHub").
 */
import type {
  Automation,
  AutomationCreateInput,
  AutomationGithubReposResult,
  AutomationHook,
  AutomationListResult,
  AutomationRun,
  AutomationRunsResult,
  AutomationUpdateInput,
  EnvironmentId,
} from "@t3tools/contracts";

import { EnvironmentHttpError, environmentFetchJson } from "~/environments/http/target";

export class AutomationApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null,
    readonly manageUrl: string | null = null,
    readonly connectUrl: string | null = null,
  ) {
    super(message);
    this.name = "AutomationApiError";
  }
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `{error: {code, message, …}}` → the error; null when it isn't one. */
export function automationErrorOf(body: unknown, status: number | null): AutomationApiError | null {
  const error = rec(rec(body)?.error);
  if (!error) return null;
  const text = (key: string) => (typeof error[key] === "string" ? (error[key] as string) : null);
  return new AutomationApiError(
    text("code") ?? "ERROR",
    text("message") ?? "Something went wrong.",
    status,
    text("manageUrl") ?? text("manage_url"),
    text("connectUrl") ?? text("connect_url"),
  );
}

/** The daemon's error message is its whole JSON body when `error` is an object. */
function fromHttpError(cause: unknown): unknown {
  if (!(cause instanceof EnvironmentHttpError)) return cause;
  try {
    const parsed = automationErrorOf(JSON.parse(cause.message), cause.status);
    if (parsed) return parsed;
  } catch {
    // Not JSON: a plain message.
  }
  return new AutomationApiError(
    cause.status === 404 ? "NOT_FOUND" : "ERROR",
    cause.message,
    cause.status,
  );
}

async function call<T>(input: Parameters<typeof environmentFetchJson>[0]): Promise<T> {
  let body: unknown;
  try {
    body = await environmentFetchJson<unknown>(input);
  } catch (cause) {
    throw fromHttpError(cause);
  }
  const error = automationErrorOf(body, null);
  if (error) throw error;
  return body as T;
}

interface Scoped {
  readonly environmentId: EnvironmentId;
}

const ROOT = "/api/manager/automations";

/**
 * The automations of the assistants on this computer. A daemon without the
 * route (older Work) reads as "disabled": the screens hide the section.
 */
export async function listAutomations(input: Scoped): Promise<AutomationListResult> {
  try {
    return await call<AutomationListResult>({
      environmentId: input.environmentId,
      pathname: ROOT,
    });
  } catch (cause) {
    if (cause instanceof AutomationApiError && (cause.status === 404 || cause.status === 405)) {
      return { available: false, reason: "disabled", automations: [] };
    }
    throw cause;
  }
}

export function createAutomation(
  input: Scoped & { readonly automation: AutomationCreateInput },
): Promise<Automation> {
  return call({
    environmentId: input.environmentId,
    pathname: ROOT,
    method: "POST",
    body: input.automation,
  });
}

export function updateAutomation(
  input: Scoped & { readonly id: number; readonly patch: AutomationUpdateInput },
): Promise<Automation> {
  return call({
    environmentId: input.environmentId,
    pathname: `${ROOT}/${input.id}`,
    method: "PATCH",
    body: input.patch,
  });
}

export async function deleteAutomation(input: Scoped & { readonly id: number }): Promise<void> {
  await call<unknown>({
    environmentId: input.environmentId,
    pathname: `${ROOT}/${input.id}`,
    method: "DELETE",
  });
}

/** "Run now": the run it queued (a PR automation takes the newest open PR). */
export async function runAutomationNow(
  input: Scoped & { readonly id: number },
): Promise<AutomationRun | null> {
  const body = await call<unknown>({
    environmentId: input.environmentId,
    pathname: `${ROOT}/${input.id}/run`,
    method: "POST",
    body: {},
  });
  const record = rec(body);
  const run = rec(record?.run) ?? (record && "state" in record ? record : null);
  return (run as AutomationRun | null) ?? null;
}

export async function listAutomationRuns(
  input: Scoped & { readonly id: number },
): Promise<ReadonlyArray<AutomationRun>> {
  const body = await call<AutomationRunsResult>({
    environmentId: input.environmentId,
    pathname: `${ROOT}/${input.id}/runs`,
  });
  return body.runs ?? [];
}

/** A webhook's URL and signing secret: read when asked, never kept on the screen. */
export function getAutomationHook(
  input: Scoped & { readonly id: number },
): Promise<AutomationHook> {
  return call({ environmentId: input.environmentId, pathname: `${ROOT}/${input.id}/hook` });
}

/** A new URL and secret; the old ones stop at once. */
export function rotateAutomationHook(
  input: Scoped & { readonly id: number },
): Promise<AutomationHook> {
  return call({
    environmentId: input.environmentId,
    pathname: `${ROOT}/${input.id}/hook/rotate`,
    method: "POST",
    body: {},
  });
}

/** Repositories the Uno GitHub app sees (the picker), and whether GitHub is connected at all. */
export function listAutomationRepos(
  input: Scoped & { readonly q?: string },
): Promise<AutomationGithubReposResult> {
  return call({
    environmentId: input.environmentId,
    pathname: `${ROOT}/github/repos`,
    ...(input.q ? { searchParams: { q: input.q } } : {}),
  });
}
