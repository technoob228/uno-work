import { ProviderDriverKind } from "@t3tools/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { useSettings, useUpdateSettings } from "../hooks/useSettings";
import { useServerProviders } from "../rpc/serverState";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";

const SKIP_FLAG_STORAGE_KEY = "uno-work:onboarding:api-key-skipped";

function hasSkippedFlag(): boolean {
  try {
    return window.localStorage.getItem(SKIP_FLAG_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function persistSkipFlag(): void {
  try {
    window.localStorage.setItem(SKIP_FLAG_STORAGE_KEY, "1");
  } catch {
    // ignore — non-blocking UX
  }
}

function clearSkipFlag(): void {
  try {
    window.localStorage.removeItem(SKIP_FLAG_STORAGE_KEY);
  } catch {
    // ignore
  }
}

const UNO_DRIVER_KIND = ProviderDriverKind.make("uno");

export function UnoOnboardingDialog() {
  const apiKey = useSettings((settings) => settings.uno?.apiKey ?? "");
  const providers = useServerProviders();
  const hasEnabledUnoInstance = useMemo(
    () => providers.some((provider) => provider.driver === UNO_DRIVER_KIND && provider.enabled),
    [providers],
  );
  const { updateSettings } = useUpdateSettings();
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const formId = useId();

  useEffect(() => {
    if (apiKey.length > 0) {
      clearSkipFlag();
      setOpen(false);
      return;
    }
    if (!hasEnabledUnoInstance) {
      setOpen(false);
      return;
    }
    if (hasSkippedFlag()) {
      return;
    }
    setOpen(true);
  }, [apiKey, hasEnabledUnoInstance]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const handleSubmit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      return;
    }
    updateSettings({ uno: { apiKey: trimmed } });
    clearSkipFlag();
    setOpen(false);
  };

  const handleSkip = () => {
    persistSkipFlag();
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          handleSkip();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Connect your Uno account</DialogTitle>
          <DialogDescription>
            {APP_BASE_NAME} can route requests through the Uno LLM Gateway. Paste your Uno API key
            to enable it. You can change this later in Settings → Uno account.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3" scrollFade={false}>
          <form
            id={formId}
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              handleSubmit();
            }}
          >
            <Input
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              name="uno-api-key"
              placeholder="sNIh…"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              aria-label="Uno API key"
            />
            <p className="text-xs text-muted-foreground">
              Stored in plain text on disk in this app's settings.
            </p>
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleSkip}>
            Skip for now
          </Button>
          <Button type="submit" form={formId} disabled={draft.trim().length === 0}>
            Save key
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
