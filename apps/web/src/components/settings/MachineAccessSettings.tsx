/**
 * Settings → Computer access: what each cloud computer (and the AI agents on
 * it) may do in the Uno account. A computer is its own limited, revocable
 * participant — never the account's master key. The person in this interface
 * changes the switches; the console applies them to the computer's token.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UnoBox } from "@t3tools/contracts";
import { CloudIcon, ShieldOffIcon } from "lucide-react";

import { accountRequest, accountTransport, interfaceUnoCloud } from "../../account/unoAccount";
import { AccountSignInCta } from "../account/AccountSignInCta";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface MachineAccess {
  readonly can_read_machines: boolean;
  readonly can_power_machines: boolean;
  readonly can_create_machines: boolean;
  readonly revoked: boolean;
  readonly token_active?: boolean;
}

type AccessKey = "can_read_machines" | "can_power_machines" | "can_create_machines";

const SWITCHES: ReadonlyArray<{ key: AccessKey; title: string; description: string }> = [
  {
    key: "can_read_machines",
    title: "See your other computers",
    description: "List the computers on your account and their state.",
  },
  {
    key: "can_power_machines",
    title: "Turn your computers on and off",
    description: "Wake, sleep, start or stop computers on your account.",
  },
  {
    key: "can_create_machines",
    title: "Add new computers",
    description:
      "Create Uno Work computers within your plan (at most a couple a day). It can never pay or change your plan.",
  },
];

const accessKey = (boxId: number) => ["account", "machineAccess", boxId] as const;

function MachineAccessCard({ box }: { readonly box: UnoBox }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: accessKey(box.id),
    queryFn: async () =>
      (await accountRequest("GET", `/api/v1/boxes/${box.id}/machine-access`)) as MachineAccess,
  });
  const update = useMutation({
    mutationFn: async (next: Partial<MachineAccess> & { revoke?: true }) => {
      if (next.revoke) {
        await accountRequest("POST", `/api/v1/boxes/${box.id}/machine-access/revoke`, {});
        return (await accountRequest(
          "GET",
          `/api/v1/boxes/${box.id}/machine-access`,
        )) as MachineAccess;
      }
      return (await accountRequest(
        "PUT",
        `/api/v1/boxes/${box.id}/machine-access`,
        next,
      )) as MachineAccess;
    },
    onSuccess: (data) => queryClient.setQueryData(accessKey(box.id), data),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Couldn't change access",
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const access = query.data;
  const revoked = access?.revoked === true;

  return (
    <SettingsSection title={`${box.name} can…`}>
      {query.isError ? (
        <SettingsRow
          title="Couldn't load this computer's access"
          description={query.error instanceof Error ? query.error.message : String(query.error)}
        />
      ) : null}
      {SWITCHES.map((item) => (
        <SettingsRow
          key={item.key}
          title={item.title}
          description={item.description}
          control={
            <Switch
              checked={!revoked && access?.[item.key] === true}
              disabled={!access || revoked || update.isPending}
              onCheckedChange={(checked) =>
                update.mutate({
                  can_read_machines: access!.can_read_machines,
                  can_power_machines: access!.can_power_machines,
                  can_create_machines: access!.can_create_machines,
                  [item.key]: checked,
                })
              }
              aria-label={item.title}
            />
          }
        />
      ))}
      <SettingsRow
        title={revoked ? "Access is revoked" : "Its own things always work"}
        description={
          revoked
            ? "This computer can't act in your Uno account at all. Chats and files on it keep working."
            : "Apps, publishing sites, cloud storage, AI and its own size and power. It can never pay, change your account, see your keys or delete other computers."
        }
        control={
          revoked ? (
            <Button
              size="xs"
              variant="outline"
              disabled={update.isPending}
              onClick={() =>
                update.mutate({
                  can_read_machines: true,
                  can_power_machines: true,
                  can_create_machines: true,
                  revoked: false,
                })
              }
            >
              Give access back
            </Button>
          ) : (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={!access || update.isPending}
              data-testid={`revoke-access-${box.id}`}
              onClick={() => update.mutate({ revoke: true })}
            >
              <ShieldOffIcon className="size-3.5" />
              Revoke access
            </Button>
          )
        }
      />
    </SettingsSection>
  );
}

export function MachineAccessSettings() {
  const transport = accountTransport();
  const cloud = useQuery({
    queryKey: ["account", "cloudState"],
    queryFn: () => interfaceUnoCloud.getState(),
    enabled: transport !== "none",
  });
  const boxes = (cloud.data?.boxes ?? []).filter((box) => box.status !== "deleted");

  return (
    <SettingsPageContainer>
      <SettingsSection title="Computer access">
        <SettingsRow
          title="What your computers may do in your Uno account"
          description="Each cloud computer — and the AI working on it — has its own limited access. Turn things off or revoke it completely; you stay in charge from here."
        />
      </SettingsSection>
      {transport === "none" || (cloud.data && !cloud.data.connected) ? (
        <AccountSignInCta className="px-1" />
      ) : boxes.length === 0 && cloud.isSuccess ? (
        <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <CloudIcon className="size-4" /> No cloud computers on this account yet.
        </p>
      ) : (
        boxes.map((box) => <MachineAccessCard key={box.id} box={box} />)
      )}
    </SettingsPageContainer>
  );
}
