/**
 * The model a chat moved from Uno AI starts on: Uno's own engine (Hermes on
 * the Uno gateway, Uno Code where Hermes can't answer) — what the welcome's
 * "Uno AI" pick sets. Without it a hand-off that skipped the welcome started
 * on whatever the machine's default was (Claude Code on a free trial
 * computer → "403 Premium models come with a paid plan", 28.09).
 */
import { DEFAULT_RUNTIME_MODE, type ModelSelection } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { pickUsableDefaultModelSelection } from "../providerModels";
import { useServerProviders } from "../rpc/serverState";
import type { HomeStartOptions } from "../components/computer/home/HomeComposer";

export function useUnoDefaultSelection(): {
  /** null while the machine hasn't said which harnesses it has. */
  readonly ready: boolean;
  readonly selection: ModelSelection | null;
  /** Start options for useHomeLaunchers().startTask on Uno's engine; also makes it the sticky default. */
  readonly startOptions: () => HomeStartOptions;
} {
  const providers = useServerProviders();
  const setSticky = useComposerDraftStore((store) => store.setStickyModelSelection);
  const selection = useMemo(
    () =>
      pickUsableDefaultModelSelection(
        providers.filter((p) => p.driver === "hermes" || p.driver === "uno"),
      ) as ModelSelection | null,
    [providers],
  );
  const startOptions = useCallback((): HomeStartOptions => {
    if (selection) setSticky(selection);
    return { folder: null, modelSelection: selection, runtimeMode: DEFAULT_RUNTIME_MODE };
  }, [selection, setSticky]);
  return { ready: providers.length > 0, selection, startOptions };
}
