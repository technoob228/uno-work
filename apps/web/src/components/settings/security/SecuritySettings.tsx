/**
 * Settings → Security: for each cloud computer, who got in (the access
 * journal) and where it can be reached from (network). One page for the whole
 * account: the overview on top covers every computer, the sections below are
 * about the one picked (this computer by default).
 *
 * Everything goes through the person's account (desktop sign-in or the
 * browser Uno Work session) — never the computer's own token, so an agent on
 * the computer can neither read the journal nor open the computer up.
 */
import { useQuery } from "@tanstack/react-query";
import { CloudIcon } from "lucide-react";
import { useState } from "react";

import { accountTransport, interfaceUnoCloud } from "../../../account/unoAccount";
import { usePrimaryEnvironmentDescriptor } from "../../../environments/primary";
import { AccountSignInCta } from "../../account/AccountSignInCta";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { AccessJournal, SecurityOverview } from "./AccessJournal";
import { NetworkAccess } from "./NetworkAccess";

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

  return (
    <SettingsPageContainer>
      <SettingsSection title="Security">
        <SettingsRow
          title="Who got into your computers, and who can reach them"
          description="Every way in — Uno Work, SSH, commands from your AI agents, Uno's own automation and maintenance — is listed here. Any access, including ours, is visible to you. Uno can do maintenance without asking first, and always tells you right away, with the reason."
        />
      </SettingsSection>
      {transport === "none" || (cloud.data && !cloud.data.connected) ? (
        <AccountSignInCta className="px-1" />
      ) : boxes.length === 0 && cloud.isSuccess ? (
        <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <CloudIcon className="size-4" /> No cloud computers on this account yet.
        </p>
      ) : (
        <>
          <SecurityOverview boxes={boxes} selectedId={selectedId} onSelect={setPicked} />
          {selected ? (
            <>
              <NetworkAccess key={`net-${selected.id}`} box={selected} />
              <AccessJournal key={`log-${selected.id}`} box={selected} />
            </>
          ) : null}
        </>
      )}
    </SettingsPageContainer>
  );
}
