/**
 * Settings → Security (a simple entry since 16.10, Misha: "out of Developer
 * settings, two levels"). On top the simple level — internet access
 * (isolation) and the red button (ProtectionSection). Under "Advanced", as
 * before: for each cloud computer, who got in (the access journal) and where
 * it can be reached from (network); the overview covers every computer, the
 * sections below are about the one picked (this computer by default).
 *
 * Everything goes through the person's account (desktop sign-in or the
 * browser Uno Work session) — never the computer's own token, so an agent on
 * the computer can neither read the journal nor open the computer up.
 */
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, CloudIcon } from "lucide-react";
import { useState } from "react";

import { accountTransport, interfaceUnoCloud } from "../../../account/unoAccount";
import { usePrimaryEnvironmentDescriptor } from "../../../environments/primary";
import { AccountSignInCta } from "../../account/AccountSignInCta";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { SettingsPageContainer } from "../settingsLayout";
import { AccessJournal, SecurityOverview } from "./AccessJournal";
import { NetworkAccess } from "./NetworkAccess";
import { ProtectionSection, useProtectionOff } from "./ProtectionSection";

export function SecuritySettings() {
  const transport = accountTransport();
  const primary = usePrimaryEnvironmentDescriptor();
  const cloud = useQuery({
    queryKey: ["account", "cloudState"],
    queryFn: () => interfaceUnoCloud.getState(),
    enabled: transport !== "none",
  });
  const boxes = (cloud.data?.boxes ?? []).filter(
    (box) => box.status !== "deleted" && box.workMachine === true,
  );
  // ?box=<id> — links from Uno's notifications ("Uno is doing maintenance on …").
  const [picked, setPicked] = useState<number | null>(() => {
    const raw =
      typeof window === "undefined" ? null : new URL(window.location.href).searchParams.get("box");
    const id = raw ? Number(raw) : Number.NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  });
  const thisBoxId = primary?.unoBoxId ?? null;
  const pickedId = picked !== null && boxes.some((b) => b.id === picked) ? picked : null;
  const selectedId =
    pickedId ?? (boxes.some((b) => b.id === thisBoxId) ? thisBoxId : (boxes[0]?.id ?? null));
  const selected = boxes.find((b) => b.id === selectedId) ?? null;
  // A link from a notification (?box=) is about the details: open Advanced.
  const [advancedOpen, setAdvancedOpen] = useState(pickedId !== null);
  const protectionOff = useProtectionOff();
  const details = (
    <>
      <SecurityOverview boxes={boxes} selectedId={selectedId} onSelect={setPicked} />
      {selected ? (
        <>
          <NetworkAccess key={`net-${selected.id}`} box={selected} />
          <AccessJournal key={`log-${selected.id}`} box={selected} />
        </>
      ) : null}
    </>
  );

  return (
    <SettingsPageContainer>
      {transport === "none" || (cloud.data && !cloud.data.connected) ? (
        <AccountSignInCta className="px-1" />
      ) : boxes.length === 0 && cloud.isSuccess ? (
        <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <CloudIcon className="size-4" /> No cloud computers on this account yet.
        </p>
      ) : protectionOff ? (
        details
      ) : (
        <>
          <ProtectionSection />
          <Collapsible
            open={advancedOpen}
            onOpenChange={setAdvancedOpen}
            className="flex flex-col gap-8"
          >
            <CollapsibleTrigger
              className="group flex w-full items-center justify-between gap-3 rounded-2xl border border-dashed border-border px-4 py-3 text-left transition-colors hover:bg-muted/40 sm:px-5"
              aria-label={advancedOpen ? "Hide advanced security" : "Show advanced security"}
            >
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-foreground">Advanced</div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
                  Who got into each computer (every way in, ours too), SSH, open ports and addresses
                  allowed in Limited mode.
                </p>
              </div>
              <ChevronDownIcon
                className={`size-4 shrink-0 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
            </CollapsibleTrigger>
            <CollapsiblePanel className="flex flex-col gap-8">{details}</CollapsiblePanel>
          </Collapsible>
        </>
      )}
    </SettingsPageContainer>
  );
}
