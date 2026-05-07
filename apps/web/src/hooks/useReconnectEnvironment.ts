import { useCallback, useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";

import { reconnectSavedEnvironment } from "../environments/runtime";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export function useReconnectEnvironment() {
  const [reconnectingId, setReconnectingId] = useState<EnvironmentId | null>(null);

  const reconnect = useCallback(async (environmentId: EnvironmentId) => {
    setReconnectingId(environmentId);
    try {
      await reconnectSavedEnvironment(environmentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to reconnect environment.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not reconnect environment",
          description: message,
        }),
      );
    } finally {
      setReconnectingId(null);
    }
  }, []);

  return { reconnect, reconnectingId };
}
