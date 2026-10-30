/**
 * The model a chat moved from Uno AI starts on: Uno's own engine (Hermes on
 * the Uno gateway, Uno Code where Hermes can't answer) — what the welcome's
 * "Uno AI" pick sets. Without it a hand-off that skipped the welcome started
 * on whatever the machine's default was (Claude Code on a free trial
 * computer → "403 Premium models come with a paid plan", 28.09; "Not logged
 * in" when it started before Hermes was checked, 16.10 — see
 * unoDefaultSelection.logic.ts).
 */
import type { ModelSelection } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { useServerProviders } from "../rpc/serverState";
import type { HomeStartOptions } from "../components/computer/home/HomeComposer";
import { UNO_CHECK_CAP_MS, resolveUnoHandoffSelection } from "./unoDefaultSelection.logic";

export function useUnoDefaultSelection(): {
  /** false while the machine hasn't said which harnesses it has, or Uno's engine is still being checked. */
  readonly ready: boolean;
  readonly selection: ModelSelection | null;
  /** Start options for useHomeLaunchers().startTask on Uno's engine; also makes it the sticky default. */
  readonly startOptions: () => HomeStartOptions;
} {
  const providers = useServerProviders();
  const setSticky = useComposerDraftStore((store) => store.setStickyModelSelection);
  const hasProviders = providers.length > 0;
  const [capReached, setCapReached] = useState(false);
  useEffect(() => {
    if (!hasProviders || capReached) return;
    const timer = setTimeout(() => setCapReached(true), UNO_CHECK_CAP_MS);
    return () => clearTimeout(timer);
  }, [hasProviders, capReached]);
  const { settled, selection } = useMemo(
    () => resolveUnoHandoffSelection(providers, capReached),
    [providers, capReached],
  );
  const startOptions = useCallback((): HomeStartOptions => {
    if (selection) setSticky(selection);
    return { folder: null, modelSelection: selection, runtimeMode: null };
  }, [selection, setSticky]);
  return { ready: settled, selection, startOptions };
}
