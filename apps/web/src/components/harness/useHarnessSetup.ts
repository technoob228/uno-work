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

import { readEnvironmentConnection } from "~/environments/runtime";
import { getPrimaryEnvironmentConnection } from "~/environments/runtime/service";
import { isPrimaryEnvironmentId } from "~/environments/http/target";
import { refreshEnvironmentProviders } from "~/environments/settings/serverSettings";
import { usePrimaryEnvironmentId } from "~/environments/primary/context";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

import { isJobActive } from "./harnessSetupState";

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
  }) => Promise<void>;
  readonly submitAuthCode: (input: {
    readonly driver: ProviderAuthDriver;
    readonly code: string;
  }) => Promise<void>;
  /** Forget a settled job so the dialog can start over. */
  readonly clearAuth: (driver: ProviderAuthDriver) => void;
  readonly clearInstall: (driver: ProviderDriverKind) => void;
}

function resolveClient(environmentId: EnvironmentId | null): WsRpcClient {
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
 * @param explicitEnvironmentId the machine to act on. Omit (or pass `null`)
 * on the onboarding screens, which always target the machine serving the UI.
 */
export function useHarnessSetup(explicitEnvironmentId?: EnvironmentId | null): HarnessSetupApi {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = explicitEnvironmentId ?? null;
  const refreshTargetId = explicitEnvironmentId ?? primaryEnvironmentId;

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
      const client = resolveClient(environmentId);
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
    async ({ driver, method, apiKey }) => {
      const client = resolveClient(environmentId);
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
        const { jobId } = await client.providerSetup.authStart({
          driver,
          method,
          ...(apiKey ? { apiKey } : {}),
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

  const submitAuthCode = useCallback<HarnessSetupApi["submitAuthCode"]>(
    async ({ driver, code }) => {
      const jobId = authIds.current.get(driver);
      if (!jobId) return;
      const client = resolveClient(environmentId);
      try {
        const status = await client.providerSetup.authSubmitCode({
          jobId: jobId as ProviderAuthJobStatus["jobId"],
          code,
        });
        setAuthJobs((current) => ({ ...current, [driver]: status }));
      } catch (error) {
        setAuthJobs((current) => {
          const existing = current[driver];
          if (!existing) return current;
          return { ...current, [driver]: { ...existing, error: errorMessage(error) } };
        });
      }
    },
    [environmentId],
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
            if (status.state === "succeeded") refreshProviders(driver);
          }
        } catch {
          authIds.current.delete(driver);
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
      submitAuthCode,
      clearAuth,
      clearInstall,
    }),
    [installJobs, authJobs, startInstall, startAuth, submitAuthCode, clearAuth, clearInstall],
  );
}
