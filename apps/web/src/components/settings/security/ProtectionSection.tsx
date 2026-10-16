/**
 * Settings → Security, the simple level (Misha 16.10): two switches anyone
 * understands.
 *
 * 1. Isolation — all computers, or one, cut off from the internet: Limited
 *    (only Uno, GitHub and app installs out; nothing in but Uno Work) or
 *    Isolated (nothing in or out; reachable only through the private network).
 * 2. The red button — "Stop everything & report": every computer of the
 *    account stops, Uno's admins are told who and which computers, the page
 *    says "We've been notified and are looking into it".
 *
 * Both go through the person's account (accountRequest), never the computer's
 * token: an agent on the computer can't loosen isolation or undo the stop.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CopyIcon,
  NetworkIcon,
  OctagonAlertIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import { useState } from "react";

import { accountRequest } from "../../../account/unoAccount";
import { Alert, AlertDescription, AlertTitle } from "../../ui/alert";
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../ui/dialog";
import { Label } from "../../ui/label";
import { QRCodeSvg } from "../../ui/qr-code";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { Toggle, ToggleGroup } from "../../ui/toggle-group";
import { SettingsRow, SettingsSection } from "../settingsLayout";
import {
  type ComputerIsolation,
  type EmergencyReport,
  type EmergencyStopBody,
  type IsolationBody,
  type IsolationMode,
  MODE_OPTIONS,
  type Protection,
  effectiveMode,
  emergencyStopPath,
  isolationPath,
  modeTitle,
  needsPrivateNetwork,
  plural,
  protectionPath,
  stoppable,
} from "./protectionModel";

const protectionKey = ["account", "security", "protection"] as const;

function statusWord(status: string): string {
  if (status === "running") return "Running";
  if (status === "sleeping" || status === "paused_ram") return "Asleep";
  if (status === "stopped" || status === "suspended") return "Stopped";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong.";
}

export function ProtectionSection() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: protectionKey,
    queryFn: async () => (await accountRequest("GET", protectionPath)) as Protection,
  });
  const setIsolation = useMutation({
    mutationFn: async (body: IsolationBody) =>
      (await accountRequest("PUT", isolationPath, body)) as Protection,
    onSuccess: (data) => queryClient.setQueryData(protectionKey, data),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change internet access",
        description: errorText(error),
      }),
  });
  const [networkOpen, setNetworkOpen] = useState(false);

  if (query.isError) {
    return (
      <SettingsSection title="Protection">
        <SettingsRow
          title="Couldn't load your protection settings"
          description={errorText(query.error)}
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
      <SettingsSection title="Protection">
        <SettingsRow title="Loading…" description="Checking how your computers are protected." />
      </SettingsSection>
    );
  }

  const all = data.isolation.all;
  const busy = setIsolation.isPending;
  const missingNetwork = needsPrivateNetwork(data);

  return (
    <>
      {data.emergency ? <EmergencyBanner report={data.emergency} /> : null}

      <SettingsSection title="Internet access" icon={<ShieldIcon className="size-3" />}>
        <SettingsRow
          title="All computers"
          description={MODE_OPTIONS.find((option) => option.value === all)?.description ?? ""}
          control={
            <ModeSwitch
              value={all}
              disabled={busy}
              label="Internet access for all computers"
              onChange={(mode) => setIsolation.mutate({ scope: "all", mode })}
            />
          }
        >
          {all === "isolated" ? (
            <IsolatedExtras
              data={data}
              missingNetwork={missingNetwork}
              onOpenNetwork={() => setNetworkOpen(true)}
            />
          ) : null}
        </SettingsRow>
        {data.isolation.computers.map((computer) => {
          const effective = effectiveMode(all, computer.mode);
          return (
            <SettingsRow
              key={computer.id}
              title={computer.name}
              description={`${statusWord(computer.status)} · ${modeTitle(effective)}${
                computer.mode === "inherit" ? "" : ", only this computer"
              }`}
              control={
                <ComputerModeSelect
                  value={computer.mode}
                  all={all}
                  disabled={busy}
                  label={`Internet access for ${computer.name}`}
                  onChange={(mode) =>
                    setIsolation.mutate({ scope: "computer", box_id: computer.id, mode })
                  }
                />
              }
            />
          );
        })}
        {all !== "isolated" && missingNetwork ? (
          <SettingsRow
            title="Set up your private network"
            description="An isolated computer answers only inside your private network. Add your laptop or phone to it to open that computer."
            control={
              <Button size="xs" onClick={() => setNetworkOpen(true)}>
                <NetworkIcon />
                Set up
              </Button>
            }
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="Emergency" icon={<ShieldAlertIcon className="size-3" />}>
        <EmergencyRow data={data} />
      </SettingsSection>

      <PrivateNetworkDialog data={data} open={networkOpen} onOpenChange={setNetworkOpen} />
    </>
  );
}

function ModeSwitch(props: {
  readonly value: IsolationMode;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (mode: IsolationMode) => void;
}) {
  return (
    <ToggleGroup
      variant="outline"
      size="sm"
      value={[props.value]}
      disabled={props.disabled}
      aria-label={props.label}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "open" || next === "limited" || next === "isolated") props.onChange(next);
      }}
    >
      {MODE_OPTIONS.map((option) => (
        <Toggle key={option.value} value={option.value} className="px-2.5 text-xs">
          {option.short}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function ComputerModeSelect(props: {
  readonly value: ComputerIsolation;
  readonly all: IsolationMode;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (mode: ComputerIsolation) => void;
}) {
  const options: ReadonlyArray<{ value: ComputerIsolation; label: string }> = [
    { value: "inherit", label: `Same as all (${modeTitle(props.all)})` },
    ...MODE_OPTIONS.map((option) => ({ value: option.value, label: option.title })),
  ];
  const current = options.find((option) => option.value === props.value) ?? options[0]!;
  return (
    <Select
      value={props.value}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value === "inherit" || value === "open" || value === "limited" || value === "isolated")
          props.onChange(value);
      }}
    >
      <SelectTrigger className="w-full sm:w-48" aria-label={props.label}>
        <SelectValue>{current.label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem hideIndicator key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function IsolatedExtras(props: {
  readonly data: Protection;
  readonly missingNetwork: boolean;
  readonly onOpenNetwork: () => void;
}) {
  const network = props.data.private_network;
  return (
    <div className="flex flex-col gap-3 pb-4 pt-3">
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2.5">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-foreground">Private network</div>
          <p className="text-xs text-muted-foreground">
            {network.set_up
              ? `${plural(network.devices.length, "device")} connected: ${network.devices
                  .map((device) => device.name)
                  .join(", ")}`
              : "No devices yet. Until you add one, you can't open your isolated computers."}
          </p>
        </div>
        <Button
          size="xs"
          variant={props.missingNetwork ? "default" : "outline"}
          onClick={props.onOpenNetwork}
        >
          <NetworkIcon />
          {network.set_up ? "Add a device" : "Set up"}
        </Button>
      </div>
      <Label className="flex items-center justify-between gap-3 font-normal">
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-medium text-foreground">Keep Uno AI on</span>
          <span className="text-xs text-muted-foreground">
            AI agents on your computers can still use Uno AI. Nothing else gets out.
          </span>
        </span>
        <Switch checked={props.data.isolation.uno_ai_when_isolated} aria-label="Keep Uno AI on" />
      </Label>
    </div>
  );
}

function EmergencyRow({ data }: { readonly data: Protection }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [signOut, setSignOut] = useState(false);
  const targets = stoppable(data.isolation.computers);
  const stop = useMutation({
    mutationFn: async (body: EmergencyStopBody) =>
      (await accountRequest("POST", emergencyStopPath, body)) as Protection,
    onSuccess: (next) => {
      queryClient.setQueryData(protectionKey, next);
      setOpen(false);
      setNote("");
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't stop your computers",
        description: `${errorText(error)} Write to us in Support — we'll stop them by hand.`,
      }),
  });

  return (
    <>
      {data.emergency?.state === "open" ? (
        <SettingsRow
          title="Reported"
          description="Uno is looking into it. If something else happens, press again — we'll stop anything you started since."
          control={
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              <OctagonAlertIcon />
              Report again
            </Button>
          }
        />
      ) : (
        <SettingsRow
          title="Something looks wrong?"
          description="Stop all your computers at once and tell Uno. Nothing is deleted — you can start them again later."
          control={
            <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
              <OctagonAlertIcon />
              Stop everything &amp; report
            </Button>
          }
        />
      )}
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop everything and report?</AlertDialogTitle>
            <AlertDialogDescription>
              {targets.length > 0
                ? `${plural(targets.length, "computer")} will stop right away: ${targets
                    .map((computer) => computer.name)
                    .join(", ")}. Their apps, bots and schedules stop too. Files stay.`
                : "All your computers are already stopped. We'll still be notified."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 px-6 pb-2">
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What did you notice? (optional)"
              rows={3}
              aria-label="What did you notice?"
            />
            <Label className="flex items-start gap-2.5 font-normal">
              <Checkbox
                checked={signOut}
                onCheckedChange={(checked) => setSignOut(checked === true)}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-[13px] text-foreground">Also sign out everywhere</span>
                <span className="text-xs text-muted-foreground">
                  Other devices are signed out, and API keys and agent keys stop working.
                </span>
              </span>
            </Label>
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={stop.isPending} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={stop.isPending}
              onClick={() =>
                stop.mutate({ sign_out: signOut, ...(note.trim() ? { note: note.trim() } : {}) })
              }
            >
              {stop.isPending ? "Stopping…" : "Stop everything & report"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function EmergencyBanner({ report }: { readonly report: EmergencyReport }) {
  const at = new Date(report.reported_at).toLocaleString([], {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  });
  if (report.state === "closed") {
    return (
      <Alert variant="success" className="rounded-2xl">
        <ShieldCheckIcon />
        <AlertTitle>We looked into your report from {at}</AlertTitle>
        <AlertDescription>
          {report.answer ?? "Everything is fine. You can start your computers again."}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="error" className="rounded-2xl">
      <OctagonAlertIcon />
      <AlertTitle>We&apos;ve been notified and are looking into it</AlertTitle>
      <AlertDescription>
        <p>
          {report.stopped.length > 0
            ? `${plural(report.stopped.length, "computer")} stopped at ${at}: ${report.stopped
                .map((computer) => computer.name)
                .join(", ")}.`
            : `Reported at ${at}.`}{" "}
          {report.signed_out ? "Other devices are signed out and keys are off. " : ""}
          We&apos;ll write to you in Inbox. Files are safe.
        </p>
        <p className="pt-1 text-muted-foreground">
          You can start a computer again in Computers whenever you&apos;re ready.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function PrivateNetworkDialog(props: {
  readonly data: Protection;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  // The mock shows a stand-in; the real one is a WireGuard config made for this device.
  const config = "uno-private-network://demo-device";
  const address = props.data.private_network.address_hint ?? "work.uno";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <NetworkIcon className="size-5 shrink-0" />
            Add a device to your private network
          </DialogTitle>
          <DialogDescription>
            Your private network connects your devices to your computers directly. Isolated
            computers answer only here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
            <li>Install the free WireGuard app on your laptop or phone.</li>
            <li>In WireGuard, add a tunnel from this QR code (or the file).</li>
            <li>
              Turn the tunnel on and open <span className="font-medium">{address}</span> — or just
              keep using Uno Work.
            </li>
          </ol>
          <div className="flex flex-col items-center gap-3">
            <QRCodeSvg value={config} size={148} className="rounded-lg bg-white p-2" />
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              {copied ? "Downloaded" : "Download the file"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              This code works once, for one device. Keep it to yourself.
            </p>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
