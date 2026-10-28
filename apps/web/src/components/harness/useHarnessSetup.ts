/**
 * Client half of the harness install / sign-in jobs.
 *
 * A job lives on the daemon; this hook starts one, polls its status once a
 * second while it is active, and asks the daemon to re-probe its providers
 * when it settles (the daemon refreshes on success too — the extra nudge is
 * what makes the row flip immediately for the client that started it).
 *
 * Keyed by driver: at most one install and one sign-in per harness, matching
 * the server's own conflict rule.
 *
 * @module components/harness/useHarnessSetup
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderAuthDriver,
  type ProviderAuthJobStatus,
  type ProviderAuthMethod,
  type ProviderDriverKind,
  type ProviderInstallJobStatus,
} from "@t3tools/contracts";

import { getPrimaryEnvironmentConnection, readEnvironmentConnection } from "~/environments/runtime";
import { isPrimaryEnvironmentId } from "~/environments/http/target";
import { refreshEnvironmentProviders } from "~/environments/settings/serverSettings";
import { usePrimaryEnvironmentId } from "~/environments/primary/context";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

import { isJobActive } from "./harnessSetupState";
import { type AdoptSignedInAgentOptions, useAdoptSignedInAgent } from "./useAdoptSignedInAgent";

export const HARNESS_SETUP_POLL_MS = 1_000;

export type InstallJobView = ProviderInstallJobStatus;
export type AuthJobView = ProviderAuthJobStatus;

export interface HarnessSetupApi {
  readonly installJobs: Readonly<Record<string, InstallJobView | undefined>>;
  readonly authJobs: Readonly<Record<string, AuthJobView | undefined>>;
  readonly startInstall: (driver: ProviderDriverKind) => Promise<void>;
  readonly startAuth: (input: {
    readonly driver: ProviderAuthDriver;
    readonly method: ProviderAuthMethod;
    readonly apiKey?: string;
    /** Drop a browser sign-in that is still waiting and start a new one. */
    readonly restart?: boolean;
  }) => Promise<void>;
  /** Stop a sign-in that waits for its browser half, and forget it here. */
  readonly cancelAuth: (driver: ProviderAuthDriver) => Promise<void>;
  readonly submitAuthCode: (input: {
    readonly driver: ProviderAuthDriver;
    readonly code: string;
  }) => Promise<void>;
  /**
   * Sign the CLI out on the machine (`claude auth logout` / `codex logout`).
   * Resolves with the daemon's answer; never throws.
   */
  readonly signOut: (
    driver: ProviderAuthDriver,
  ) => Promise<{ readonly signedOut: boolean; readonly error?: string }>;
  /** Forget a settled job so the dialog can start over. */
  readonly clearAuth: (driver: ProviderAuthDriver) => void;
  readonly clearInstall: (driver: ProviderDriverKind) => void;
}

export function resolveClient(environmentId: EnvironmentId | null): WsRpcClient {
  if (environmentId === null || isPrimaryEnvironmentId(environmentId)) {
    return getPrimaryEnvironmentConnection().client;
  }
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new Error("Reconnect this machine before installing or signing in to a harness.");
  }
  return connection.client;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The daemon doesn't know this job (it restarted, or the job is long gone):
 * nothing to wait for any more. Anything else — a reconnecting socket, a
 * timeout — is worth asking again.
 */
export function isLostJobError(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  if (code === "notFound") return true;
  return /unknown sign-in job|unknown install job/i.test(errorMessage(error));
}

/** What a sign-in that the computer forgot reads as. */
export const LOST_SIGN_IN_MESSAGE =
  "This sign-in stopped on the computer (it may have restarted). Get a new link and sign in again.";

/**
 * @param explicitEnvironmentId the machine to act on. Omit (or pass `null`)
 * on the onboarding screens, which always target the machine serving the UI.
 */
export function useHarnessSetup(
  explicitEnvironmentId?: EnvironmentId | null,
  options: {
    /** What a sign-in that lands here also changes (useAdoptSignedInAgent). */
    readonly adopt?: AdoptSignedInAgentOptions;
  } = {},
): HarnessSetupApi {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = explicitEnvironmentId ?? null;
  const refreshTargetId = explicitEnvironmentId ?? primaryEnvironmentId;
  // A sign-in finished here: new chats start on that agent, and Claude's
  // plan powers the assistant too — one sign-in for both (P2/P3, 28.10).
  const adopt = useAdoptSignedInAgent(refreshTargetId, options.adopt);
  const onSignedInRef = useRef<
    ((driver: ProviderAuthDriver, method: ProviderAuthMethod) => void) | null
  >(adopt);
  useEffect(() => {
    onSignedInRef.current = adopt;
  }, [adopt]);

  const [installJobs, setInstallJobs] = useState<Record<string, InstallJobView | undefined>>({});
  const [authJobs, setAuthJobs] = useState<Record<string, AuthJobView | undefined>>({});
  // Job ids are read by the poller; keeping them in a ref avoids restarting
  // the interval on every status tick.
  const installIds = useRef(new Map<string, string>());
  const authIds = useRef(new Map<string, string>());

  const refreshProviders = useCallback(
    (driver: string) => {
      if (!refreshTargetId) return;
      void refreshEnvironmentProviders(
        refreshTargetId,
        defaultInstanceIdForDriver(driver as ProviderDriverKind),
      ).catch(() => {
        // A refresh that fails is not worth interrupting the flow for; the
        // daemon re-probes on its own schedule anyway.
      });
    },
    [refreshTargetId],
  );

  const startInstall = useCallback(
    async (driver: ProviderDriverKind) => {
      setInstallJobs((current) => ({
        ...current,
        [driver]: {
          jobId: "" as ProviderInstallJobStatus["jobId"],
          driver,
          state: "queued",
          log: "",
          command: "",
        },
      }));
      try {
        // Inside the try so a machine we cannot reach reads as a failed job
        // with its reason, not as an unhandled rejection.
        const client = resolveClient(environmentId);
        const { jobId } = await client.providerSetup.installStart({ driver });
        installIds.current.set(driver, jobId);
      } catch (error) {
        installIds.current.delete(driver);
        setInstallJobs((current) => ({
          ...current,
          [driver]: {
            jobId: "" as ProviderInstallJobStatus["jobId"],
            driver,
            state: "failed",
            log: "",
            command: "",
            error: errorMessage(error),
          },
        }));
      }
    },
    [environmentId],
  );

  const startAuth = useCallback<HarnessSetupApi["startAuth"]>(
    async ({ driver, method, apiKey, restart }) => {
      setAuthJobs((current) => ({
        ...current,
        [driver]: {
          jobId: "" as ProviderAuthJobStatus["jobId"],
          driver,
          method,
          state: "queued",
          log: "",
          needsCodeInput: false,
        },
      }));
      try {
        const client = resolveClient(environmentId);
        // A browser sign-in that was already waiting on the machine (this page
        // was closed or reloaded meanwhile) comes back as the same job: the
        // poller shows its link and code again.
        const { jobId } = await client.providerSetup.authStart({
          driver,
          method,
          ...(apiKey ? { apiKey } : {}),
          ...(restart ? { restart: true } : {}),
        });
        authIds.current.set(driver, jobId);
      } catch (error) {
        authIds.current.delete(driver);
        setAuthJobs((current) => ({
          ...current,
          [driver]: {
            jobId: "" as ProviderAuthJobStatus["jobId"],
            driver,
            method,
            state: "failed",
            log: "",
            needsCodeInput: false,
            error: errorMessage(error),
          },
        }));
      }
    },
    [environmentId],
  );

  const cancelAuth = useCallback<HarnessSetupApi["cancelAuth"]>(
    async (driver) => {
      authIds.current.delete(driver);
      setAuthJobs((current) => ({ ...current, [driver]: undefined }));
      try {
        await resolveClient(environmentId).providerSetup.authCancel({ driver });
      } catch {
        // An older daemon has no cancel: its sign-in times out by itself.
      }
    },
    [environmentId],
  );

  const submitAuthCode = useCallback<HarnessSetupApi["submitAuthCode"]>(
    async ({ driver, code }) => {
      // Shown at once, whatever the daemon says next (P4, 28.10: Submit did
      // nothing visible for 25 s).
      setAuthJobs((current) => {
        const existing = current[driver];
        if (!existing) return current;
        const { error: _error, ...rest } = existing;
        return {
          ...current,
          [driver]: { ...rest, needsCodeInput: false, codeCheck: "checking" },
        };
      });
      const failSubmit = (message: string, lost: boolean) =>
        setAuthJobs((current) => {
          const existing = current[driver];
          if (!existing) return current;
          return {
            ...current,
            [driver]: lost
              ? { ...existing, state: "failed", needsCodeInput: false, error: message }
              : { ...existing, needsCodeInput: true, codeCheck: undefined, error: message },
          };
        });
      let client: WsRpcClient;
      try {
        client = resolveClient(environmentId);
      } catch (error) {
        failSubmit(errorMessage(error), false);
        return;
      }
      let jobId = authIds.current.get(driver);
      if (!jobId) {
        // This page lost track of the sign-in (a failed status check used to
        // drop it, and Submit then did nothing). If it still waits on the
        // computer, it comes back as the same job and takes the code.
        try {
          const resumed = await client.providerSetup.authStart({ driver, method: "oauth" });
          if (!resumed.resumed) {
            // Nothing was waiting: the code belongs to a sign-in that is gone.
            // Stop the one this just started; "Try again" begins cleanly.
            await client.providerSetup.authCancel({ driver }).catch(() => undefined);
            failSubmit(LOST_SIGN_IN_MESSAGE, true);
            return;
          }
          authIds.current.set(driver, resumed.jobId);
          jobId = resumed.jobId;
        } catch (error) {
          failSubmit(errorMessage(error), false);
          return;
        }
      }
      try {
        const status = await client.providerSetup.authSubmitCode({
          jobId: jobId as ProviderAuthJobStatus["jobId"],
          code,
        });
        setAuthJobs((current) => ({
          ...current,
          // An older daemon says nothing about the code: it is being checked.
          [driver]: status.codeCheck ? status : { ...status, codeCheck: "checking" },
        }));
      } catch (error) {
        const lost = isLostJobError(error);
        if (lost) authIds.current.delete(driver);
        failSubmit(lost ? LOST_SIGN_IN_MESSAGE : errorMessage(error), lost);
      }
    },
    [environmentId],
  );

  const signOut = useCallback<HarnessSetupApi["signOut"]>(
    async (driver) => {
      try {
        const client = resolveClient(environmentId);
        const result = await client.providerSetup.authSignOut({ driver });
        authIds.current.delete(driver);
        setAuthJobs((current) => ({ ...current, [driver]: undefined }));
        refreshProviders(driver);
        return result.error
          ? { signedOut: result.signedOut, error: result.error }
          : { signedOut: result.signedOut };
      } catch (error) {
        return { signedOut: false, error: errorMessage(error) };
      }
    },
    [environmentId, refreshProviders],
  );

  const clearAuth = useCallback((driver: ProviderAuthDriver) => {
    authIds.current.delete(driver);
    setAuthJobs((current) => ({ ...current, [driver]: undefined }));
  }, []);

  const clearInstall = useCallback((driver: ProviderDriverKind) => {
    installIds.current.delete(driver);
    setInstallJobs((current) => ({ ...current, [driver]: undefined }));
  }, []);

  const hasActiveJob =
    Object.values(installJobs).some(isJobActive) || Object.values(authJobs).some(isJobActive);

  useEffect(() => {
    if (!hasActiveJob) return;
    let cancelled = false;

    const poll = async () => {
      let client: WsRpcClient;
      try {
        client = resolveClient(environmentId);
      } catch {
        return;
      }

      // Snapshot the maps: settled jobs are deleted from them while iterating.
      for (const [driver, jobId] of Array.from(installIds.current)) {
        try {
          const status = await client.providerSetup.installStatus({
            jobId: jobId as ProviderInstallJobStatus["jobId"],
          });
          if (cancelled) return;
          setInstallJobs((current) => ({ ...current, [driver]: status }));
          if (!isJobActive(status)) {
            installIds.current.delete(driver);
            if (status.state === "succeeded") refreshProviders(driver);
          }
        } catch {
          installIds.current.delete(driver);
        }
      }

      for (const [driver, jobId] of Array.from(authIds.current)) {
        try {
          const status = await client.providerSetup.authStatus({
            jobId: jobId as ProviderAuthJobStatus["jobId"],
          });
          if (cancelled) return;
          setAuthJobs((current) => ({ ...current, [driver]: status }));
          if (!isJobActive(status)) {
            authIds.current.delete(driver);
            if (status.state === "succeeded") {
              refreshProviders(driver);
              onSignedInRef.current?.(driver as ProviderAuthDriver, status.method);
            }
          }
        } catch (error) {
          if (cancelled) return;
          // Only a job the computer doesn't know any more is over; a missed
          // check (the socket reconnecting while the person is on claude.ai)
          // is asked again next second. Dropping the job here froze the
          // dialog: its Submit had no job to send the code to (P4, 28.10).
          if (!isLostJobError(error)) continue;
          authIds.current.delete(driver);
          setAuthJobs((current) => {
            const existing = current[driver];
            if (!existing || !isJobActive(existing)) return current;
            return {
              ...current,
              [driver]: {
                ...existing,
                state: "failed",
                needsCodeInput: false,
                error: LOST_SIGN_IN_MESSAGE,
              },
            };
          });
        }
      }
    };

    const timer = setInterval(() => void poll(), HARNESS_SETUP_POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [environmentId, hasActiveJob, refreshProviders]);

  return useMemo(
    () => ({
      installJobs,
      authJobs,
      startInstall,
      startAuth,
      cancelAuth,
      submitAuthCode,
      signOut,
      clearAuth,
      clearInstall,
    }),
    [
      installJobs,
      authJobs,
      startInstall,
      startAuth,
      cancelAuth,
      submitAuthCode,
      signOut,
      clearAuth,
      clearInstall,
    ],
  );
}
