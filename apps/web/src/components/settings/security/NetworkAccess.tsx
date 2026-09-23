/**
 * Settings → Security → "Who can reach it": where a cloud computer answers
 * from. Uno Work itself always works; SSH, apps and ports follow the choice
 * here. Every switch applies right away (the address list has a Save button).
 * The console keeps each port's own setting, so opening the computer again
 * brings back exactly what was there before.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { UnoBox } from "@t3tools/contracts";
import { ExternalLinkIcon, LockIcon, PlusIcon, ShieldIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { accountRequest } from "../../../account/unoAccount";
import { usePrimaryEnvironmentDescriptor } from "../../../environments/primary";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Radio, RadioGroup } from "../../ui/radio-group";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import {
  addAddress,
  choosablePorts,
  MODE_OPTIONS,
  networkErrorText,
  type NetworkPolicyBody,
  type NetworkSecurity,
  type OpenMode,
  policyBody,
  reachability,
  sameAddresses,
  toggledPorts,
} from "./networkModel";

const networkKey = (boxId: number) => ["account", "securityNetwork", boxId] as const;

export function NetworkAccess({ box }: { readonly box: UnoBox }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const primary = usePrimaryEnvironmentDescriptor();
  const isThisComputer = primary?.unoBoxId === box.id;
  const path = `/api/v1/boxes/${box.id}/security/network`;

  const query = useQuery({
    queryKey: networkKey(box.id),
    queryFn: async () => (await accountRequest("GET", path)) as NetworkSecurity,
  });
  const save = useMutation({
    mutationFn: async (body: NetworkPolicyBody) =>
      (await accountRequest("PUT", path, body)) as NetworkSecurity,
    onSuccess: (data) => {
      queryClient.setQueryData(networkKey(box.id), data);
      setDraft(null);
      setPendingAllowlist(false);
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change who can reach this computer",
        description: networkErrorText(error),
      }),
  });

  const [confirmClose, setConfirmClose] = useState(false);
  // The address list being edited (null = not edited, show what is saved).
  const [draft, setDraft] = useState<ReadonlyArray<string> | null>(null);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  // "Only from these addresses" picked while the list is still empty: the
  // mode is applied together with the first Save.
  const [pendingAllowlist, setPendingAllowlist] = useState(false);

  if (query.isError) {
    return (
      <SettingsSection title="Who can reach it">
        <SettingsRow
          title="Couldn't load this computer's network"
          description={networkErrorText(query.error)}
          control={
            <Button size="xs" variant="outline" onClick={() => void query.refetch()}>
              Try again
            </Button>
          }
        />
      </SettingsSection>
    );
  }
  const data = query.data;
  if (!data) {
    return (
      <SettingsSection title="Who can reach it">
        <SettingsRow title="Loading…" description="Checking where this computer answers from." />
      </SettingsSection>
    );
  }

  const policy = data.policy;
  const busy = save.isPending;
  const apply = (patch: Partial<NetworkPolicyBody>) => save.mutate(policyBody(policy, patch));
  const open = policy.internet === "open";
  const mode: OpenMode = pendingAllowlist ? "allowlist" : policy.open_mode;
  const addresses = draft ?? policy.allowed_ips;
  const addressesChanged = !sameAddresses(addresses, policy.allowed_ips) || pendingAllowlist;
  const ports = choosablePorts(data.ports);
  const rows = reachability(data.ports);
  const yourIp = data.your_ip ?? null;

  const pickMode = (next: OpenMode) => {
    if (next === mode) return;
    if (next === "allowlist" && policy.allowed_ips.length === 0) {
      setPendingAllowlist(true);
      return;
    }
    setPendingAllowlist(false);
    apply({ open_mode: next });
  };
  const addTyped = (raw: string) => {
    const result = addAddress(addresses, raw);
    setTypedError(result.error);
    if (result.error === null) {
      setDraft(result.list);
      setTyped("");
    }
  };

  return (
    <SettingsSection title="Who can reach it">
      <SettingsRow
        title="Uno Work"
        description="Always on. This is how you use the computer; it can't be turned off."
        control={
          <>
            <LockIcon className="size-3.5 text-muted-foreground" aria-hidden />
            <Switch checked disabled aria-label="Uno Work is always on" />
          </>
        }
      />
      <SettingsRow
        title="SSH"
        description={
          policy.ssh_enabled
            ? "For developers: sign in to the computer's command line from your own terminal."
            : "SSH is closed. Uno Work keeps working."
        }
        control={
          <Switch
            checked={policy.ssh_enabled}
            disabled={busy}
            onCheckedChange={(checked) => apply({ ssh_enabled: checked })}
            aria-label="SSH"
          />
        }
      />
      <SettingsRow
        title="Open to the internet"
        description={
          open
            ? "Apps and ports you opened answer from the internet, the way you choose below."
            : "Closed. Apps and ports don't answer from the internet (only SSH, if it's on). Your apps still open for you inside Uno Work."
        }
        control={
          <Switch
            checked={open}
            disabled={busy}
            onCheckedChange={(checked) => {
              if (checked) apply({ internet: "open" });
              else setConfirmClose(true);
            }}
            aria-label="Open to the internet"
          />
        }
      >
        {open ? (
          <div className="pb-4 pt-3">
            <RadioGroup
              value={mode}
              onValueChange={(value) => pickMode(value as OpenMode)}
              disabled={busy}
              aria-label="How it's open"
              className="flex flex-col gap-3"
            >
              {MODE_OPTIONS.map((option) => (
                <div key={option.value} className="flex flex-col gap-2">
                  <Label className="flex cursor-pointer items-start gap-2.5 font-normal">
                    <Radio value={option.value} className="mt-0.5" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[13px] font-medium text-foreground">
                        {option.title}
                      </span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </Label>
                  {option.value === "ports" && mode === "ports" ? (
                    <div className="ml-7 flex flex-col gap-2">
                      {ports.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No apps or ports are open on this computer yet. Uno Work and SSH are set
                          above.
                        </p>
                      ) : (
                        ports.map((port) => (
                          <Label
                            key={port.internalPort}
                            className="flex cursor-pointer items-center gap-2 font-normal"
                          >
                            <Checkbox
                              checked={policy.open_ports.includes(port.internalPort)}
                              disabled={busy}
                              onCheckedChange={(checked) =>
                                apply({
                                  open_ports: toggledPorts(
                                    policy.open_ports,
                                    port.internalPort,
                                    checked === true,
                                  ),
                                })
                              }
                            />
                            <span className="text-[13px] text-foreground">{port.title}</span>
                          </Label>
                        ))
                      )}
                    </div>
                  ) : null}
                  {option.value === "allowlist" && mode === "allowlist" ? (
                    <div className="ml-7 flex flex-col gap-2">
                      {addresses.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          Add the addresses that may reach this computer, then press Save.
                        </p>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {addresses.map((address) => (
                            <li
                              key={address}
                              className="flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-mono text-xs"
                            >
                              {address}
                              <button
                                type="button"
                                className="text-muted-foreground hover:text-foreground"
                                aria-label={`Remove ${address}`}
                                disabled={busy}
                                onClick={() => setDraft(addresses.filter((a) => a !== address))}
                              >
                                <XIcon className="size-3" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      <form
                        className="flex flex-wrap items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          addTyped(typed);
                        }}
                      >
                        <Input
                          size="sm"
                          className="w-52"
                          placeholder="203.0.113.7"
                          value={typed}
                          onChange={(event) => setTyped(event.target.value)}
                          aria-label="Address to add"
                        />
                        <Button size="xs" variant="outline" type="submit" disabled={busy}>
                          <PlusIcon className="size-3.5" />
                          Add
                        </Button>
                        {yourIp && !addresses.includes(yourIp) ? (
                          <Button
                            size="xs"
                            variant="outline"
                            type="button"
                            disabled={busy}
                            onClick={() => addTyped(yourIp)}
                          >
                            Add my address ({yourIp})
                          </Button>
                        ) : null}
                      </form>
                      {typedError ? (
                        <p className="text-xs text-destructive-foreground">{typedError}</p>
                      ) : null}
                      <div className="flex items-center gap-2">
                        <Button
                          size="xs"
                          disabled={busy || !addressesChanged || addresses.length === 0}
                          onClick={() =>
                            save.mutate(
                              policyBody(policy, {
                                open_mode: "allowlist",
                                allowed_ips: addresses,
                              }),
                            )
                          }
                        >
                          Save
                        </Button>
                        {addressesChanged ? (
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => {
                              setDraft(null);
                              setPendingAllowlist(false);
                              setTypedError(null);
                            }}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {option.value === "vpn" && mode === "vpn" ? (
                    <div className="ml-7 flex flex-col gap-2">
                      {data.vpn.installed ? (
                        <>
                          <p className="text-xs text-muted-foreground">
                            Add your phone or laptop in the VPN app, then open apps by their private
                            address.
                          </p>
                          {data.vpn.app_url ? (
                            <Button
                              size="xs"
                              variant="outline"
                              className="self-start"
                              render={
                                <a href={data.vpn.app_url} target="_blank" rel="noreferrer" />
                              }
                            >
                              <ExternalLinkIcon className="size-3.5" />
                              Open VPN app
                            </Button>
                          ) : null}
                        </>
                      ) : isThisComputer ? (
                        <>
                          <p className="text-xs text-muted-foreground">
                            You need the VPN app on this computer first. Install WireGuard from the
                            App Store.
                          </p>
                          <Button
                            size="xs"
                            variant="outline"
                            className="self-start"
                            onClick={() =>
                              void navigate({ to: "/computer", search: { store: "1" } })
                            }
                          >
                            <ShieldIcon className="size-3.5" />
                            Set up VPN
                          </Button>
                        </>
                      ) : (
                        <p className="text-xs text-muted-foreground">
                          You need the VPN app on this computer first. Open Uno Work on {box.name}{" "}
                          and install WireGuard from the App Store.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
            </RadioGroup>
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title="Reachable from the internet right now"
        description={
          rows.length === 0
            ? "Nothing on this computer is open to the internet."
            : "Every way into this computer from outside, and who it answers to."
        }
      >
        {rows.length > 0 ? (
          <ul className="flex flex-col gap-1.5 pb-4 pt-3">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs">
                <span className="min-w-24 font-medium text-foreground">{row.title}</span>
                <span className="font-mono text-muted-foreground">{row.address}</span>
                <span
                  className={
                    row.status === "public"
                      ? "text-warning-foreground"
                      : row.status === "allowlist"
                        ? "text-info-foreground"
                        : "text-muted-foreground"
                  }
                >
                  {row.statusLabel}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {box.name} to the internet?</AlertDialogTitle>
            <AlertDialogDescription>
              Apps and ports on this computer will stop answering from the internet. Uno Work keeps
              working, and your apps still open for you inside Uno Work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmClose(false);
                apply({ internet: "closed" });
              }}
            >
              Close to the internet
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
