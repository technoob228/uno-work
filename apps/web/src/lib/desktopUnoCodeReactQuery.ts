import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ProviderInstanceId, type UnoCodeInstallState } from "@t3tools/contracts";
import { ensureLocalApi } from "~/localApi";

export const desktopUnoCodeQueryKeys = {
  all: ["desktop", "uno-code"] as const,
  state: () => ["desktop", "uno-code", "state"] as const,
};

const UNO_INSTANCE_ID = ProviderInstanceId.make("uno");

export const setDesktopUnoCodeInstallStateQueryData = (
  queryClient: QueryClient,
  state: UnoCodeInstallState | null,
) => queryClient.setQueryData(desktopUnoCodeQueryKeys.state(), state);

export function desktopUnoCodeInstallStateQueryOptions() {
  return queryOptions({
    queryKey: desktopUnoCodeQueryKeys.state(),
    queryFn: async () => {
      const bridge = window.desktopBridge;
      if (!bridge || typeof bridge.getUnoCodeInstallState !== "function") return null;
      return bridge.getUnoCodeInstallState();
    },
    staleTime: Infinity,
    refetchOnMount: "always",
  });
}

export function useDesktopUnoCodeInstallState() {
  const queryClient = useQueryClient();
  const query = useQuery(desktopUnoCodeInstallStateQueryOptions());
  // Track previous status so we only fire a backend refresh on the
  // transition into "installed" (not on every subsequent event for an
  // already-installed harness).
  const prevStatusRef = useRef<UnoCodeInstallState["status"] | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.onUnoCodeInstallState !== "function") return;

    return bridge.onUnoCodeInstallState((nextState) => {
      const prev = prevStatusRef.current;
      prevStatusRef.current = nextState?.status ?? null;
      setDesktopUnoCodeInstallStateQueryData(queryClient, nextState);

      if (nextState?.status === "installed" && prev !== "installed") {
        // Force the backend to re-probe the Uno provider snapshot now —
        // otherwise users wait up to SNAPSHOT_REFRESH_INTERVAL (5 min)
        // before "Unavailable" flips to "Available".
        void ensureLocalApi()
          .server.refreshProviders({ instanceId: UNO_INSTANCE_ID })
          .catch((error: unknown) => {
            console.error("[uno-code] refreshProviders after install failed", error);
          });
      }
    });
  }, [queryClient]);

  return query;
}
