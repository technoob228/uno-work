import {
  CheckIcon,
  ChevronsUpDownIcon,
  CloudIcon,
  GlobeIcon,
  MonitorIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import { AddEnvModal } from "./AddEnvModal";
import { cn } from "../lib/utils";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { Menu, MenuPopup, MenuTrigger } from "./ui/menu";

interface DemoEnv {
  id: string;
  name: string;
  meta: string;
  kind: "local" | "uno" | "custom";
}

const FALLBACK_ENV: DemoEnv = { id: "local", name: "This device", meta: "macOS", kind: "local" };
const DEMO_ENVS: ReadonlyArray<DemoEnv> = [FALLBACK_ENV];

const KIND_ICON: Record<DemoEnv["kind"], typeof MonitorIcon> = {
  local: MonitorIcon,
  uno: CloudIcon,
  custom: GlobeIcon,
};

const GROUP_LABELS: Record<DemoEnv["kind"], string> = {
  local: "Local",
  uno: "Uno VPS",
  custom: "Custom",
};

export function SidebarEnvSwitcher() {
  const [addEnvOpen, setAddEnvOpen] = useState(false);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const currentId = primaryEnvironmentId ?? "local";

  const current = DEMO_ENVS.find((e) => e.id === currentId) ?? FALLBACK_ENV;
  const groups = (Object.keys(GROUP_LABELS) as DemoEnv["kind"][])
    .map((kind) => ({
      kind,
      items: DEMO_ENVS.filter((e) => e.kind === kind),
    }))
    .filter((g) => g.items.length > 0);

  const CurrentIcon = KIND_ICON[current.kind];

  return (
    <>
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left transition-colors hover:bg-accent"
              aria-label="Switch environment"
            >
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-emerald-500" />
              <CurrentIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{current.name}</div>
                <div className="truncate text-[10px] text-muted-foreground">{current.meta}</div>
              </div>
              <ChevronsUpDownIcon className="size-3 shrink-0 text-muted-foreground" />
            </button>
          }
        />
        <MenuPopup align="start" side="top" sideOffset={6} className="min-w-[15rem] p-1">
          {groups.map((group) => (
            <div key={group.kind} className="flex flex-col">
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                {GROUP_LABELS[group.kind]}
              </div>
              {group.items.map((env) => {
                const Icon = KIND_ICON[env.kind];
                const isActive = env.id === currentId;
                return (
                  <button
                    key={env.id}
                    type="button"
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                      isActive && "bg-accent/60",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className="size-2 shrink-0 rounded-full bg-emerald-500"
                    />
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{env.name}</div>
                      <div className="truncate text-[10px] text-muted-foreground">{env.meta}</div>
                    </div>
                    {isActive ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="my-1 h-px bg-border" />
          <button
            type="button"
            onClick={() => setAddEnvOpen(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-primary transition-colors hover:bg-primary/8"
          >
            <PlusIcon className="size-3.5" />
            <span>Add new environment</span>
          </button>
        </MenuPopup>
      </Menu>
      <AddEnvModal open={addEnvOpen} onOpenChange={setAddEnvOpen} />
    </>
  );
}
