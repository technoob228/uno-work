/**
 * Home's composer: type a task, press Enter, and a new chat starts on it — in
 * the home folder, or in a project folder picked from the chip, on the model
 * picked here (the chat composer's own picker; a pick sticks for the next new
 * chat, as it does there) and with the chosen permissions. The chat sends the
 * task itself (the same send as Enter in a chat).
 */
import {
  DEFAULT_RUNTIME_MODE,
  isAssistantProjectId,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  HouseIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import { useComposerDraftStore } from "../../../composerDraftStore";
import { useEnvironmentProviders } from "../../../environments/settings/serverSettings";
import { useSettings } from "../../../hooks/useSettings";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../../../modelSelection";
import { PERMISSION_MODES, PERMISSION_MODE_ORDER } from "../../../plainLanguage";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { selectProjectsAcrossEnvironments, useStore } from "../../../store";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import { ChatInFolderDialog } from "../ChatInFolderDialog";
import { homeStartModelSelection } from "./homeStartModel";

const SUGGESTIONS = [
  "Make me an app that…",
  "Publish a site from a folder",
  "Clean up my Downloads folder",
  "Explain what's running on this computer",
];

const MAX_FOLDERS = 8;

const RUNTIME_MODE_ICON: Record<RuntimeMode, LucideIcon> = {
  "approval-required": LockIcon,
  "auto-accept-edits": PenLineIcon,
  "full-access": LockOpenIcon,
};

export interface HomeStartOptions {
  /** The folder to work in; null = the home folder. */
  readonly folder: string | null;
  /** Null = nothing usable to pick; the chat falls back to its own default. */
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
}

/**
 * The chat composer's model picker, fed the same way: this computer's
 * harnesses, the default a new chat would get, and a pick that sticks.
 */
function useHomeModelPicker(environmentId: EnvironmentId | null) {
  const providers = useEnvironmentProviders(environmentId);
  const settings = useSettings();
  const stickyActiveProvider = useComposerDraftStore((store) => store.stickyActiveProvider);
  const stickyModelSelectionByProvider = useComposerDraftStore(
    (store) => store.stickyModelSelectionByProvider,
  );
  const setStickyModelSelection = useComposerDraftStore((store) => store.setStickyModelSelection);
  const instanceEntries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(providers)),
    [providers],
  );
  const modelOptionsByInstance = useMemo(() => {
    const out = new Map<ProviderInstanceId, ReturnType<typeof getAppModelOptionsForInstance>>();
    for (const entry of instanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [instanceEntries, settings]);
  const selection = useMemo(
    () =>
      homeStartModelSelection({
        stickyActiveProvider,
        stickyModelSelectionByProvider,
        providers,
        settings,
      }),
    [providers, settings, stickyActiveProvider, stickyModelSelectionByProvider],
  );
  const pick = (instanceId: ProviderInstanceId, model: string) => {
    const resolved = resolveAppModelSelectionForInstance(instanceId, settings, providers, model);
    if (!resolved) return;
    // What the chat composer does on a pick: it becomes the next chat's default.
    setStickyModelSelection({ instanceId, model: resolved });
  };
  return { selection, instanceEntries, modelOptionsByInstance, pick };
}

export function HomeComposer({
  environmentId,
  onStart,
}: {
  environmentId: EnvironmentId | null;
  /** Starts a chat on `options` and sends `prompt`. */
  onStart: (prompt: string, options: HomeStartOptions) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [pickingFolder, setPickingFolder] = useState(false);
  const [folder, setFolder] = useState<{ cwd: string; name: string } | null>(null);
  const [starting, setStarting] = useState(false);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>(DEFAULT_RUNTIME_MODE);
  const [pickerOpen, setPickerOpen] = useState(false);
  const picker = useHomeModelPicker(environmentId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const folders = useMemo(
    () =>
      projects
        .filter(
          (project) => project.environmentId === environmentId && !isAssistantProjectId(project.id),
        )
        .toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        .slice(0, MAX_FOLDERS),
    [environmentId, projects],
  );

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    const prompt = text.trim();
    if (!prompt || starting) {
      ref.current?.focus();
      return;
    }
    setStarting(true);
    try {
      await onStart(prompt, {
        folder: folder?.cwd ?? null,
        modelSelection: picker.selection,
        runtimeMode,
      });
      setText("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't start the chat",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="rounded-[20px] border bg-card shadow-xs/5 transition-colors has-focus-visible:border-ring/45">
        <textarea
          ref={ref}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="What should Uno do? For example: build a sales report from the sheets in my cloud"
          aria-label="Give Uno a task"
          data-testid="home-composer"
          className="block min-h-[64px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          <Menu>
            <MenuTrigger
              render={
                <Button size="xs" variant="ghost" className="text-muted-foreground">
                  {folder ? <FolderIcon /> : <HouseIcon />}
                  <span className="max-w-48 truncate">{folder ? folder.name : "Home folder"}</span>
                  <ChevronDownIcon className="opacity-60" />
                </Button>
              }
            />
            <MenuPopup align="start">
              <MenuGroup>
                <MenuGroupLabel>Work in</MenuGroupLabel>
                <MenuItem onClick={() => setFolder(null)}>
                  <HouseIcon />
                  Home folder
                </MenuItem>
                {folders.map((project) => (
                  <MenuItem
                    key={project.id}
                    onClick={() => setFolder({ cwd: project.cwd, name: project.name })}
                  >
                    <FolderIcon />
                    <span className="max-w-64 truncate">{project.name}</span>
                  </MenuItem>
                ))}
              </MenuGroup>
              <MenuSeparator />
              <MenuItem onClick={() => setPickingFolder(true)}>
                <FolderOpenIcon />
                Another folder…
              </MenuItem>
            </MenuPopup>
          </Menu>
          {picker.selection ? (
            <ProviderModelPicker
              compact
              activeInstanceId={picker.selection.instanceId}
              model={picker.selection.model}
              lockedProvider={null}
              instanceEntries={picker.instanceEntries}
              environmentId={environmentId}
              modelOptionsByInstance={picker.modelOptionsByInstance}
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              onInstanceModelChange={(instanceId, model) => {
                picker.pick(instanceId, model);
                ref.current?.focus();
              }}
              triggerVariant="ghost"
              triggerClassName="text-muted-foreground"
            />
          ) : null}
          <Select value={runtimeMode} onValueChange={(value) => setRuntimeMode(value!)}>
            <SelectTrigger
              variant="ghost"
              size="sm"
              className="h-7 w-auto shrink-0 rounded-full px-2.5 text-xs text-muted-foreground hover:text-foreground"
              aria-label="Permissions"
              title={PERMISSION_MODES[runtimeMode].consequence}
              data-testid="home-permissions"
            >
              {(() => {
                const Icon = RUNTIME_MODE_ICON[runtimeMode];
                return <Icon className="size-3.5" />;
              })()}
              <SelectValue>{PERMISSION_MODES[runtimeMode].label}</SelectValue>
            </SelectTrigger>
            <SelectPopup alignItemWithTrigger={false}>
              {PERMISSION_MODE_ORDER.map((mode) => {
                const Icon = RUNTIME_MODE_ICON[mode];
                return (
                  <SelectItem key={mode} value={mode} className="min-w-64 py-2">
                    <div className="grid min-w-0 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                        {PERMISSION_MODES[mode].label}
                      </span>
                      <span className="text-xs leading-4 text-muted-foreground">
                        {PERMISSION_MODES[mode].consequence}
                      </span>
                    </div>
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
          <button
            type="button"
            onClick={() => void submit()}
            aria-label="Start"
            disabled={starting}
            className={cn(
              "ml-auto flex size-8 items-center justify-center rounded-full transition-colors",
              text.trim()
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            {starting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => {
              setText(suggestion);
              ref.current?.focus();
            }}
            className="rounded-full border border-border/70 bg-card/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {suggestion}
          </button>
        ))}
      </div>
      <ChatInFolderDialog
        environmentId={environmentId}
        open={pickingFolder}
        onOpenChange={setPickingFolder}
        title="Work in a folder"
        description="Uno works with the files in the folder you pick."
        actionLabel={(name) => `Work in ${name}`}
        actionIcon={<FolderIcon />}
        onStart={async (cwd) => {
          setFolder({ cwd, name: cwd.replace(/\/+$/, "").split("/").pop() || cwd });
          ref.current?.focus();
        }}
      />
    </div>
  );
}
