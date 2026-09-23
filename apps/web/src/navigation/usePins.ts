/**
 * Sidebar pins of this computer, read from and written to its settings
 * (`pins`). Writes are optimistic; a failed write shows a toast.
 */
import type { UnoPin, UnoPinKind } from "@t3tools/contracts";
import { useCallback } from "react";

import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { toastManager } from "../components/ui/toast";
import { addPin, findPin, removePin, renamePin } from "./pins";

const EMPTY: ReadonlyArray<UnoPin> = [];
const selectPins = (settings: { readonly pins?: ReadonlyArray<UnoPin> }) => settings.pins ?? EMPTY;

export function usePins() {
  const pins = useSettings(selectPins);
  const { updateSettings } = useUpdateSettings();

  const write = useCallback(
    (next: UnoPin[]) => {
      updateSettings({ pins: next }).catch(() => {
        toastManager.add({ type: "error", title: "Couldn't save the sidebar pins" });
      });
    },
    [updateSettings],
  );

  const isPinned = useCallback(
    (kind: UnoPinKind, target: string) => findPin(pins, kind, target) !== null,
    [pins],
  );
  const pin = useCallback((input: Omit<UnoPin, "id">) => write(addPin(pins, input)), [pins, write]);
  const unpin = useCallback((id: string) => write(removePin(pins, id)), [pins, write]);
  const toggle = useCallback(
    (input: Omit<UnoPin, "id">) => {
      const existing = findPin(pins, input.kind, input.target);
      write(existing ? removePin(pins, existing.id) : addPin(pins, input));
    },
    [pins, write],
  );
  const rename = useCallback(
    (id: string, title: string) => write(renamePin(pins, id, title)),
    [pins, write],
  );

  return { pins, isPinned, pin, unpin, toggle, rename };
}
