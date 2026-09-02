/**
 * secretRequestStore - Pending agent-initiated secret requests.
 *
 * Filled by BrowserBridgeListener from `secretRequest` bridge events and
 * drained on submit/decline or on a `secretSettled` event (which also covers
 * another tab answering first). Holds metadata only — never secret values.
 */

import { useSyncExternalStore } from "react";
import type { BridgeSecretRequestEvent, EnvironmentId } from "@t3tools/contracts";

export interface ActiveSecretRequest {
  readonly event: BridgeSecretRequestEvent;
  readonly environmentId: EnvironmentId;
}

let requests: readonly ActiveSecretRequest[] = [];
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const addSecretRequest = (entry: ActiveSecretRequest): void => {
  if (requests.some((request) => request.event.requestId === entry.event.requestId)) {
    return;
  }
  requests = [...requests, entry];
  emit();
};

export const removeSecretRequest = (requestId: string): void => {
  const next = requests.filter((request) => request.event.requestId !== requestId);
  if (next.length === requests.length) {
    return;
  }
  requests = next;
  emit();
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const readSnapshot = (): readonly ActiveSecretRequest[] => requests;

export const useSecretRequests = (): readonly ActiveSecretRequest[] =>
  useSyncExternalStore(subscribe, readSnapshot, readSnapshot);
