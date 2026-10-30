/**
 * Settings → AI → "Use more than one account" (off by default; upstream
 * 560ddb14d9): a second Claude / ChatGPT account on this computer, with its
 * own sign-in folder, its own limits in "Your AI plans" and its own entry in
 * the model picker. Nothing switches between accounts by itself: at the limit
 * a chat offers "Continue with <account>", and that button is the only way.
 */
import type { EnvironmentId, ProviderAuthDriver, ProviderInstanceId } from "@t3tools/contracts";
import { isSecondAccountInstance } from "@t3tools/shared/planLimitRules";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ensureEnvironmentApi } from "../../environmentApi";
import {
  refreshEnvironmentProviders,
  useEnvironmentProviders,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../environments/settings/serverSettings";
import { HarnessSignInDialog } from "../harness/HarnessSignInDialog";
import { useHarnessSetup } from "../harness/useHarnessSetup";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

/** Short and honest, like upstream's note: this is the whole warning. */
export const MULTIPLE_ACCOUNTS_WARNING =
  "We don't recommend this: Anthropic or OpenAI may limit or ban an account for it. Uno Work never switches accounts by itself, only when you press a button.";

const PROVIDER_LABEL: Readonly<Record<ProviderAuthDriver, string>> = {
  claudeAgent: "Claude",
  codex: "ChatGPT",
};

export { isSecondAccountInstance };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function AccountSignIn({
  environmentId,
  driver,
  instanceId,
  name,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderAuthDriver;
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const setup = useHarnessSetup(environmentId, { instanceId });
  const queryClient = useQueryClient();
  const signedIn = setup.authJobs[driver]?.state === "succeeded";
  useEffect(() => {
    // Its row in "Your AI plans" and its "Continue with" come from these numbers.
    if (signedIn) void queryClient.invalidateQueries({ queryKey: ["home", "plan-limits"] });
  }, [queryClient, signedIn]);
  return (
    <HarnessSignInDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      driver={driver}
      label={name}
      job={setup.authJobs[driver]}
      accountOnly
      onStart={(input) => void setup.startAuth({ driver, ...input })}
      onCancel={() => void setup.cancelAuth(driver)}
      onSubmitCode={(code) => void setup.submitAuthCode({ driver, code })}
      onReset={() => setup.clearAuth(driver)}
    />
  );
}

function AddAccountDialog({
  environmentId,
  driver,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly driver: ProviderAuthDriver;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState("Personal");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
  } | null>(null);
  const label = PROVIDER_LABEL[driver];

  const add = async () => {
    if (busy || name.trim().length === 0) return;
    setBusy(true);
    try {
      const result = await ensureEnvironmentApi(environmentId).unoComputer.providerAccountAdd({
        driver,
        name: name.trim(),
      });
      await refreshEnvironmentProviders(environmentId, result.instanceId).catch(() => undefined);
      setAdded(result);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Couldn't add a ${label} account`,
        description: errorText(error),
      });
    } finally {
      setBusy(false);
    }
  };

  if (added) {
    return (
      <AccountSignIn
        environmentId={environmentId}
        driver={driver}
        instanceId={added.instanceId}
        name={added.displayName}
        onClose={onClose}
      />
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add another {label} account</DialogTitle>
          <DialogDescription>
            It signs in separately and shows up in the model picker. On the sign-in page, pick the
            other account.
          </DialogDescription>
        </DialogHeader>
        <form
          id="add-provider-account"
          className="flex flex-col gap-1.5 px-4 pb-2 sm:px-6"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <label className="text-xs font-medium" htmlFor="add-provider-account-name">
            Name
          </label>
          <Input
            id="add-provider-account-name"
            value={name}
            maxLength={32}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            placeholder="Personal or Work"
            data-testid="add-provider-account-name"
          />
        </form>
        <DialogFooter>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            type="submit"
            form="add-provider-account"
            disabled={busy || name.trim().length === 0}
            data-testid="add-provider-account-continue"
          >
            {busy ? "Adding…" : "Continue"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SecondAccountRow({
  environmentId,
  instanceId,
  driver,
  name,
  detail,
  signedIn,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderAuthDriver;
  readonly name: string;
  readonly detail: string;
  readonly signedIn: boolean;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    const confirmed = window.confirm(
      `Remove ${name} from this computer? It signs out here. Chats on it stop until you pick another model.`,
    );
    if (!confirmed) return;
    setRemoving(true);
    try {
      const result = await ensureEnvironmentApi(environmentId).unoComputer.providerAccountRemove({
        instanceId,
      });
      if (result.error) {
        toastManager.add({
          type: "warning",
          title: "Removed, but it didn't sign out",
          description: result.error,
        });
      }
      await refreshEnvironmentProviders(environmentId).catch(() => undefined);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't remove the account",
        description: errorText(error),
      });
    } finally {
      setRemoving(false);
    }
  };
  return (
    <li className="flex min-w-0 items-center gap-3 text-xs" data-testid="second-account">
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{name}</div>
        <div className="truncate text-[11px] text-muted-foreground">{detail}</div>
      </div>
      {signedIn ? null : (
        <Button size="xs" variant="outline" onClick={() => setSigningIn(true)}>
          Sign in
        </Button>
      )}
      <Button
        size="xs"
        variant="ghost"
        disabled={removing}
        onClick={() => void remove()}
        data-testid="second-account-remove"
      >
        {removing ? "Removing…" : "Remove"}
      </Button>
      {signingIn ? (
        <AccountSignIn
          environmentId={environmentId}
          driver={driver}
          instanceId={instanceId}
          name={name}
          onClose={() => setSigningIn(false)}
        />
      ) : null}
    </li>
  );
}

export function MultipleAccountsRows({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const { updateSettings } = useUpdateEnvironmentSettings(environmentId);
  const [confirming, setConfirming] = useState(false);
  const [adding, setAdding] = useState<ProviderAuthDriver | null>(null);
  const [saving, setSaving] = useState(false);
  const on = settings?.multipleAccounts ?? false;

  /** Off hides the second accounts everywhere, signed in; on brings them back. */
  const save = (next: boolean) => {
    if (!settings) return;
    const providerInstances = Object.fromEntries(
      Object.entries(settings.providerInstances ?? {}).map(([instanceId, instance]) => [
        instanceId,
        isSecondAccountInstance(instanceId) ? { ...instance, enabled: next } : instance,
      ]),
    );
    setSaving(true);
    void Promise.resolve(updateSettings({ multipleAccounts: next, providerInstances }))
      .catch((error: unknown) =>
        toastManager.add({ type: "error", title: "Couldn't save", description: errorText(error) }),
      )
      .finally(() => setSaving(false));
  };

  const accounts = providers.filter(
    (provider) =>
      isSecondAccountInstance(provider.instanceId) &&
      (provider.driver === "claudeAgent" || provider.driver === "codex"),
  );

  return (
    <SettingsRow
      title="Use more than one account"
      description={
        on
          ? MULTIPLE_ACCOUNTS_WARNING
          : "Sign in to a second Claude or ChatGPT account on this computer. Each keeps its own limits."
      }
      control={
        <Switch
          checked={on}
          disabled={saving || settings === null}
          onCheckedChange={(next) => (next === true ? setConfirming(true) : save(false))}
          aria-label="Use more than one account"
          data-testid="settings-multiple-accounts"
        />
      }
    >
      {on ? (
        <div className="mt-3 flex flex-col gap-3 pb-4" data-testid="multiple-accounts">
          {accounts.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {accounts.map((provider) => {
                const signedIn = provider.auth.status === "authenticated";
                return (
                  <SecondAccountRow
                    key={provider.instanceId}
                    environmentId={environmentId}
                    instanceId={provider.instanceId}
                    driver={provider.driver as ProviderAuthDriver}
                    name={
                      provider.displayName ?? PROVIDER_LABEL[provider.driver as ProviderAuthDriver]
                    }
                    detail={signedIn ? (provider.auth.email ?? "Signed in") : "Not signed in yet"}
                    signedIn={signedIn}
                  />
                );
              })}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="xs"
              variant="outline"
              onClick={() => setAdding("claudeAgent")}
              data-testid="add-claude-account"
            >
              Add another Claude account
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setAdding("codex")}
              data-testid="add-chatgpt-account"
            >
              Add another ChatGPT account
            </Button>
          </div>
        </div>
      ) : null}
      {adding ? (
        <AddAccountDialog
          environmentId={environmentId}
          driver={adding}
          onClose={() => setAdding(null)}
        />
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup data-testid="multiple-accounts-warning">
          <AlertDialogHeader>
            <AlertDialogTitle>Use more than one account?</AlertDialogTitle>
            <AlertDialogDescription>{MULTIPLE_ACCOUNTS_WARNING}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button size="sm" variant="ghost" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              onClick={() => {
                setConfirming(false);
                save(true);
              }}
              data-testid="multiple-accounts-confirm"
            >
              Turn on
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}
