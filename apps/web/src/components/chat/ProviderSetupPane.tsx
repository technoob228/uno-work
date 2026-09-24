/**
 * What the model picker shows for a provider that cannot serve models yet:
 * an Install panel (binary missing) or a Sign in panel (no account). Both
 * drive the same daemon jobs as onboarding and settings via `useHarnessSetup`;
 * this file only lays them out inside the picker's content pane.
 *
 * @module components/chat/ProviderSetupPane
 */
import { useNavigate } from "@tanstack/react-router";
import { CheckCircle2, Copy, Loader2, TriangleAlert } from "lucide-react";
import { memo, useState } from "react";

import type { EnvironmentId } from "@t3tools/contracts";

import {
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../environments/primary";
import { useEnvironmentScope } from "../../environments/scope/scopes";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { CURSOR_LOGIN_COMMAND, HARNESS_REAUTH_COPY } from "../harness/harnessAuthLoss";
import { describeSignInState, HarnessSignInPanel } from "../harness/HarnessSignInDialog";
import { OpenCodeKeyForm } from "../harness/OpenCodeKeyForm";
import { isAuthableDriver, isJobActive, progressLine } from "../harness/harnessSetupState";
import { SetupLogDetails } from "../harness/SetupLogDetails";
import type { HarnessSetupApi } from "../harness/useHarnessSetup";
import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  providerPaneBadgeLabel,
  SIGN_IN_ELSEWHERE_DRIVERS,
  type ProviderPaneKind,
} from "./modelPickerProviderPane";

/** Label of the machine the install runs on, as the user knows it. */
function useMachineLabel(environmentId: EnvironmentId | null): string {
  const scope = useEnvironmentScope(environmentId);
  const primary = usePrimaryEnvironmentDescriptor();
  return scope?.label ?? primary?.label ?? "this computer";
}

function PaneHeader(props: { entry: ProviderInstanceEntry; badge: string | null }) {
  return (
    <div className="flex items-center gap-2">
      <ProviderInstanceIcon
        driverKind={props.entry.driverKind}
        displayName={props.entry.displayName}
        accentColor={props.entry.accentColor}
        className="size-7"
        iconClassName="size-5"
      />
      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
        {props.entry.displayName}
      </span>
      {props.badge ? (
        <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-600 dark:text-amber-400">
          {props.badge}
        </span>
      ) : null}
    </div>
  );
}

function InstallPane(props: {
  entry: ProviderInstanceEntry;
  setup: HarnessSetupApi;
  environmentId: EnvironmentId | null;
}) {
  const { entry, setup } = props;
  const machineLabel = useMachineLabel(props.environmentId);
  const job = setup.installJobs[entry.driverKind];
  const installing = isJobActive(job);
  const failed = job?.state === "failed";
  const succeeded = job?.state === "succeeded";
  const hint = installing ? progressLine(job?.log ?? "") : undefined;

  return (
    <div className="flex flex-col gap-3" data-model-picker-pane="install">
      <PaneHeader
        entry={entry}
        badge={providerPaneBadgeLabel({ kind: "install", installJob: job })}
      />
      <p className="text-xs leading-snug text-muted-foreground">
        Install {entry.displayName} on {machineLabel}. Runs as your user, no terminal needed.
      </p>

      {installing ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Installing…
          </div>
          {hint ? (
            <div className="truncate font-mono text-[11px] text-muted-foreground">{hint}</div>
          ) : null}
          <SetupLogDetails log={job?.log ?? ""} label="Show log" />
        </div>
      ) : succeeded ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 text-success" />
          Installed. Loading models…
        </div>
      ) : failed ? (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
          <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 break-words">{job?.error ?? "The install failed."}</span>
          </div>
          <SetupLogDetails log={job?.log ?? ""} label="Show log" />
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() => void setup.startInstall(entry.driverKind)}
          >
            Retry
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          className="self-start"
          onClick={() => void setup.startInstall(entry.driverKind)}
        >
          Install
        </Button>
      )}
    </div>
  );
}

/**
 * Sign-in for a harness without the in-app dialog — the same fix the chat's
 * signed-out card offers: OpenCode takes a new key, Uno AI / Hermes sign in
 * with the Uno key in Settings, Cursor logs in from a terminal.
 */
function SignInElsewherePane(props: {
  entry: ProviderInstanceEntry;
  environmentId: EnvironmentId | null;
}) {
  const { entry } = props;
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryEnvironmentId;
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const driver = String(entry.driverKind);
  const openSettings = () => {
    if (!environmentId) return;
    void navigate({
      to: "/settings/environment/$environmentId/providers",
      params: { environmentId },
    });
  };

  return (
    <div className="flex flex-col gap-3" data-model-picker-pane="signin">
      <PaneHeader entry={entry} badge={providerPaneBadgeLabel({ kind: "signin" })} />
      {driver === "opencode" ? (
        <>
          <p className="text-xs leading-snug text-muted-foreground">
            {saved ? "Key saved. Checking OpenCode…" : HARNESS_REAUTH_COPY.openCodeMessage}
          </p>
          {saved ? null : <OpenCodeKeyForm className="mt-0" onSaved={() => setSaved(true)} />}
        </>
      ) : driver === "cursor" ? (
        <>
          <p className="text-xs leading-snug text-muted-foreground">
            {HARNESS_REAUTH_COPY.cursorMessage}
          </p>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(CURSOR_LOGIN_COMMAND)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
            className="inline-flex items-center gap-2 self-start rounded-md border border-border bg-background px-2 py-1 font-mono text-xs hover:bg-muted"
          >
            {CURSOR_LOGIN_COMMAND}
            <Copy className="size-3 text-muted-foreground" />
          </button>
          {copied ? (
            <span className="text-[11px] text-muted-foreground">
              {HARNESS_REAUTH_COPY.copyCommandDone}
            </span>
          ) : null}
        </>
      ) : (
        <>
          <p className="text-xs leading-snug text-muted-foreground">
            {HARNESS_REAUTH_COPY.unoMessage}
          </p>
          <Button size="sm" className="self-start" onClick={openSettings}>
            {HARNESS_REAUTH_COPY.signInAction}
          </Button>
        </>
      )}
    </div>
  );
}

function SignInPane(props: {
  entry: ProviderInstanceEntry;
  setup: HarnessSetupApi;
  environmentId: EnvironmentId | null;
}) {
  const { entry, setup } = props;
  const driver = entry.driverKind;
  if (!isAuthableDriver(driver)) {
    return SIGN_IN_ELSEWHERE_DRIVERS.has(driver) ? (
      <SignInElsewherePane entry={entry} environmentId={props.environmentId} />
    ) : null;
  }
  const job = setup.authJobs[driver];

  return (
    <div className="flex flex-col gap-3" data-model-picker-pane="signin">
      <PaneHeader entry={entry} badge={providerPaneBadgeLabel({ kind: "signin" })} />
      <p className="text-xs leading-snug text-muted-foreground">
        {describeSignInState(entry.displayName, job)}
      </p>
      <HarnessSignInPanel
        key={driver}
        driver={driver}
        job={job}
        onStart={({ method, apiKey }) =>
          void setup.startAuth({ driver, method, ...(apiKey ? { apiKey } : {}) })
        }
        onSubmitCode={(code) => void setup.submitAuthCode({ driver, code })}
        onReset={() => setup.clearAuth(driver)}
      />
    </div>
  );
}

export const ProviderSetupPane = memo(function ProviderSetupPane(props: {
  entry: ProviderInstanceEntry;
  kind: Extract<ProviderPaneKind, "install" | "signin">;
  setup: HarnessSetupApi;
  environmentId: EnvironmentId | null;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {props.kind === "install" ? (
        <InstallPane entry={props.entry} setup={props.setup} environmentId={props.environmentId} />
      ) : (
        <SignInPane entry={props.entry} setup={props.setup} environmentId={props.environmentId} />
      )}
    </div>
  );
});
