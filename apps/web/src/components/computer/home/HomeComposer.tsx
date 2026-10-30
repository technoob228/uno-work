/**
 * Home's composer: type a task, press Enter, and a new chat starts on it — in
 * the home folder, or in a project folder picked from the chip, on the model
 * picked here (the chat composer's own picker; a pick sticks for the next new
 * chat, as it does there) and with the chosen permissions. The chat sends the
 * task itself (the same send as Enter in a chat).
 *
 * Under the box one row of light pills (Misha 01.10, "simple hint buttons"):
 * the starters (a click fills the box and focuses it — never sends), then
 * "I have a project" (`onUploadProject`). A folder / .zip dropped anywhere on
 * the box is taken too (`onDropProject`) — or, when a task is already typed,
 * it becomes the chip's folder (like "Upload a folder…") and the text stays.
 * Pictures are not a project: a screenshot pasted, dropped or picked with the
 * paperclip is attached to the first message, as in the chat itself.
 * A newcomer's first screen
 * (`minimal`) is the box, the model with its reasoning, and the pills: no
 * folder chip or permissions picker — the defaults a new chat gets. The model
 * shows from the start (Misha 28.10: after signing in to Claude the box had
 * "no model, no reasoning" — he couldn't see Claude was there and picked).
 *
 * "Show the agent" (Loom Work, 28.10) sits next to "Add a project": the same
 * recording as the chat's Record button. Its card waits in this box (saving,
 * watching, Retry), the words go in once, and on Enter it moves to the new
 * chat, whose first message carries it (see `screenRecording/homeRecording.ts`).
 *
 * The chat box's shortcuts work here too: ⌘Enter sends and stays on Home (the
 * chat opens for a moment: the send lives in it, see `pendingSendStore`), ⌘S
 * sets the task aside or brings it back.
 */
import {
  DEFAULT_RUNTIME_MODE,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  ArrowUpIcon,
  FileIcon,
  LoaderCircleIcon,
  MicIcon,
  SquareIcon,
  FolderIcon,
  FolderUpIcon,
  LockIcon,
  LockOpenIcon,
  PaperclipIcon,
  PenLineIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useMemo, useRef, useState } from "react";

import { resolveComposerSubmissionIntent } from "~/composer-logic";
import {
  loadComposerStash,
  registerStashTarget,
  setAsideOrBringBack,
  useComposerStashStore,
  type StashedMessage,
} from "~/composerStashStore";
import { resolveShortcutCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { useServerKeybindings } from "~/rpc/serverState";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../../composerDraftStore";
import {
  useEnvironmentProviders,
  useEnvironmentSettings,
  useEnvironmentServerConfig,
} from "../../../environments/settings/serverSettings";
import { useSettings } from "../../../hooks/useSettings";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelectionForInstance,
} from "../../../modelSelection";
import { openFolderForChat } from "../../../navigation/newProjectStore";
import { PERMISSION_MODES, PERMISSION_MODE_ORDER } from "../../../plainLanguage";
import { dataTransferHasFolderOrZip, readDroppedUploadFiles } from "../../../projectUploadPickers";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../../providerInstances";
import { RecordButton, screenRecordingAvailable } from "../../../screenRecording/RecordButton";
import { RecordingComposerCard } from "../../../screenRecording/RecordingCards";
import {
  homeRecordingKey,
  homeRecordingPrefill,
  homeSendCheck,
} from "../../../screenRecording/homeRecording";
import { useScreenRecordingStore } from "../../../screenRecording/recordingStore";
import { type DictationDraft, resolveDictationInsert } from "../../../hooks/dictationDraft";
import { isDictationSupported, useDictation } from "../../../hooks/useDictation";
import { withAppShortcutDefaults } from "../../appShortcuts.logic";
import { ComposerStashMenu, toastSetAside } from "../../chat/ComposerStashMenu";
import { type TeamMember, useStartableAssistants } from "../../assistants/useAssistantTeam";
import { NewChatComputerPicker } from "../../chat/NewChatComputerPicker";
import {
  useNameAmongComputers,
  useSwitcherMachines,
} from "../../computerSwitcher/useComputerSwitcher";
import { useSpacesOn } from "../../../spaces";
import { useStore } from "../../../store";
import { HomePlanRoomLine } from "../../chat/PlanRoomNotice";
import { NewChatFolderPicker } from "../../chat/NewChatFolderPicker";
import { ProviderModelPicker } from "../../chat/ProviderModelPicker";
import { TraitsPicker } from "../../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { Skeleton } from "../../ui/skeleton";
import { FIRST_SNAPSHOT_MAX_WAIT_MS } from "../../../lib/firstSnapshot";
import { Spinner } from "../../ui/spinner";
import { toastManager } from "../../ui/toast";
import type { PickedFolder } from "../FolderChipMenu";
import { homeAttachmentsFromFiles } from "./homeAttachments";
import { homeStartModelSelection } from "./homeStartModel";
import { useOwnAgentStart } from "./useOwnAgentStart";
import { useSetupHandoff } from "../../setup/useSetupHome";
import type { HomeStarter } from "./homeStarters";

const carriesFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

const RUNTIME_MODE_ICON: Record<RuntimeMode, LucideIcon> = {
  "approval-required": LockIcon,
  "auto-accept-edits": PenLineIcon,
  "full-access": LockOpenIcon,
};

export interface HomeStartOptions {
  /** The computer to start on (the box's computer pick); absent = Home's computer. */
  readonly environmentId?: EnvironmentId | null;
  /** The folder to work in; null = the home folder. */
  readonly folder: string | null;
  /** The chat starts with this assistant, in its folder and on its own model. */
  readonly assistant?: ScopedProjectRef | null;
  /** Null = nothing usable to pick; the chat falls back to its own default. */
  readonly modelSelection: ModelSelection | null;
  /** Null: what Settings say for this computer and folder. */
  readonly runtimeMode: RuntimeMode | null;
  /** Pictures attached on Home; they go into the new chat's first message. */
  readonly images?: ReadonlyArray<ComposerImageAttachment>;
  /** Other files attached on Home (saved to ~/Uploads when the chat sends). */
  readonly files?: ReadonlyArray<ComposerFileAttachment>;
  /** Home's screen recording (its store key): it moves to the new chat and goes with the message. */
  readonly recordingKey?: string;
  /** ⌘Enter: the person stays on Home. */
  readonly inBackground?: boolean;
}

/**
 * The chat composer's model picker, fed the same way: this computer's
 * harnesses, the default a new chat would get, and a pick that sticks.
 */
export function useHomeModelPicker(
  environmentId: EnvironmentId | null,
  options: { readonly ownAgentStart?: boolean } = {},
) {
  const providers = useEnvironmentProviders(environmentId);
  const clientSettings = useSettings();
  // The model set for this computer is the chosen computer's, not this window's.
  const computerModel = useEnvironmentSettings(environmentId)?.defaultModelSelection ?? null;
  const settings = useMemo(
    () => ({ ...clientSettings, defaultModelSelection: computerModel }),
    [clientSettings, computerModel],
  );
  // Home's box for someone who came for their own agent starts on it, not on
  // Uno's own harness (Settings' pickers keep the plain default).
  const ownAgent = useOwnAgentStart(options.ownAgentStart === true);
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
  // A pick made here, for this start. With "New chats start on" set (15.10)
  // the sticky pick no longer moves the start model, so it is held here.
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const selection = useMemo(() => {
    if (picked) {
      const provider = providers.find((candidate) => candidate.instanceId === picked.instanceId);
      const model =
        provider?.enabled && provider.installed
          ? resolveAppModelSelectionForInstance(
              picked.instanceId,
              settings,
              providers,
              picked.model,
            )
          : null;
      if (model) return { ...picked, model };
    }
    return homeStartModelSelection({
      stickyActiveProvider,
      stickyModelSelectionByProvider,
      providers,
      settings,
      ownAgent,
    });
  }, [ownAgent, picked, providers, settings, stickyActiveProvider, stickyModelSelectionByProvider]);
  const pick = (instanceId: ProviderInstanceId, model: string) => {
    const resolved = resolveAppModelSelectionForInstance(instanceId, settings, providers, model);
    if (!resolved) return;
    setPicked({ instanceId, model: resolved });
    // What the chat composer does on a pick: it becomes the last one picked.
    setStickyModelSelection({ instanceId, model: resolved });
  };
  /** Effort and the other traits: kept on the sticky pick, as the chat composer does. */
  const setOptions = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    if (!selection) return;
    const next: ModelSelection = {
      instanceId: selection.instanceId,
      model: selection.model,
      ...(options && options.length > 0 ? { options } : {}),
    };
    setPicked(next);
    setStickyModelSelection(next);
  };
  return { selection, instanceEntries, modelOptionsByInstance, pick, setOptions };
}

export function HomeComposer({
  environmentId,
  starters,
  defaultFolder = null,
  onStart,
  placeholder = "What should Uno do? For example: build a sales report from the sheets in my cloud",
  onUploadProject,
  onDropProject,
  minimal = false,
  ariaLabel = "What should we do?",
  onStarter,
}: {
  environmentId: EnvironmentId | null;
  /** The folder the chip starts on (the setup's project); null = the home folder. */
  defaultFolder?: PickedFolder | null;
  /** Pills under the composer (see homeStarters.ts); a click only pre-fills. */
  starters: ReadonlyArray<Pick<HomeStarter, "id" | "label" | "prompt" | "folder">>;
  /** Starts a chat on `options` and sends `prompt`. */
  onStart: (prompt: string, options: HomeStartOptions) => Promise<void>;
  placeholder?: string;
  /** The last pill, "I have a project": upload a folder / .zip. */
  onUploadProject?: () => void;
  /** Files / a folder dropped on the box. */
  onDropProject?: (data: DataTransfer) => void;
  /** Only the box, the arrow and the pills (a newcomer's first screen; pills centred). */
  minimal?: boolean;
  ariaLabel?: string;
  /** A pill with its own action (the assistant opens its quiz): true — handled, don't pre-fill. */
  onStarter?: (id: string) => boolean;
}) {
  // A first task handed over by the setup's last step is typed in, once.
  const [handoff] = useState(() => useSetupHandoff.getState().take());
  const [text, setText] = useState(handoff?.text ?? "");
  const [folder, setFolder] = useState<PickedFolder | null>(handoff?.folder ?? defaultFolder);
  const assistants = useStartableAssistants();
  const [assistant, setAssistant] = useState<TeamMember | null>(null);
  const [starting, setStarting] = useState(false);
  // Null until the person picks here: Settings decide.
  const [pickedRuntimeMode, setRuntimeMode] = useState<RuntimeMode | null>(null);
  const computerRuntimeMode = useEnvironmentSettings(environmentId ?? null)?.defaultRuntimeMode;
  const runtimeMode = pickedRuntimeMode ?? computerRuntimeMode ?? DEFAULT_RUNTIME_MODE;
  const [pickerOpen, setPickerOpen] = useState(false);
  // "on [computer ▾]" picks Home's computer: outside a chat there is one, and the
  // new chat, Terminal, Files and Apps all go to it until another one is picked.
  const targetEnvironmentId = environmentId;
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);
  const pickComputer = (next: EnvironmentId) => {
    setActiveEnvironmentId(next);
    // Folders belong to a computer: a new one starts in its home folder.
    setFolder(null);
  };
  const severalComputers = useSwitcherMachines().length > 1;
  // A space is its computer: nothing to pick inside it.
  const spacesOn = useSpacesOn();
  const assistantComputer = useNameAmongComputers(
    (assistant?.environmentId as EnvironmentId | undefined) ?? null,
  );
  const picker = useHomeModelPicker(targetEnvironmentId, { ownAgentStart: true });
  // The computer hasn't sent its config yet: the model chip is not known, so a
  // placeholder of its size holds the row (else it appears late and pushes
  // Permissions aside - S6 flicker recipe b).
  // Capped like the first snapshot: a computer that never answers ends with no
  // chip, not an endless shimmer.
  const modelChipConfigMissing = useEnvironmentServerConfig(targetEnvironmentId) === null;
  const [modelChipWaitOver, setModelChipWaitOver] = useState(false);
  useEffect(() => {
    if (!modelChipConfigMissing || modelChipWaitOver) return;
    const timer = window.setTimeout(() => setModelChipWaitOver(true), FIRST_SNAPSHOT_MAX_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [modelChipConfigMissing, modelChipWaitOver]);
  const modelChipPending = modelChipConfigMissing && !modelChipWaitOver;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [dragging, setDragging] = useState(false);
  const [images, setImages] = useState<ComposerImageAttachment[]>([]);
  const [files, setFiles] = useState<ComposerFileAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Loom Work: Home's own recording (one per computer), shown as the chat shows it.
  const [recordingSupported] = useState(screenRecordingAvailable);
  const recordingKey = environmentId ? homeRecordingKey(environmentId) : null;
  const recording = useScreenRecordingStore((state) =>
    recordingKey ? (state.items[recordingKey] ?? null) : null,
  );
  const markRecordingPrefilled = useScreenRecordingStore((state) => state.markPrefilled);
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const prefill = homeRecordingPrefill(recording, textRef.current);
    if (!recording || !prefill.mark) return;
    markRecordingPrefilled(recording.threadKey);
    if (prefill.text !== null) setText(prefill.text);
  }, [recording, markRecordingPrefilled]);
  // Dictation, as in the chat's composer: the words go where the caret was,
  // or at the end if the person kept typing meanwhile.
  const [dictationSupported] = useState(isDictationSupported);
  const captureDictationDraft = (): DictationDraft => ({
    owner: "home",
    text: textRef.current,
    cursor: ref.current?.selectionStart ?? textRef.current.length,
  });
  const dictation = useDictation({
    captureDraft: captureDictationDraft,
    onTranscript: (words, captured) => {
      const result = resolveDictationInsert(captured, captureDictationDraft(), words);
      if (result.kind !== "insert") return;
      const current = textRef.current;
      const next = current.slice(0, result.at) + result.insertion + current.slice(result.at);
      setText(next);
      const caret = result.at + result.insertion.length;
      requestAnimationFrame(() => {
        ref.current?.focus();
        ref.current?.setSelectionRange(caret, caret);
      });
    },
    onError: (message) =>
      toastManager.add({ type: "error", title: "Dictation failed.", description: message }),
  });
  const dictationLabel =
    dictation.state === "recording"
      ? "Stop and transcribe"
      : dictation.state === "transcribing"
        ? "Transcribing…"
        : "Dictate";
  const selectedEntry = picker.selection
    ? picker.instanceEntries.find((entry) => entry.instanceId === picker.selection?.instanceId)
    : undefined;

  const attachFiles = (picked: ReadonlyArray<File>) => {
    if (picked.length === 0) return;
    const result = homeAttachmentsFromFiles(picked, images.length + files.length);
    if (result.images.length > 0) setImages((current) => [...current, ...result.images]);
    if (result.files.length > 0) setFiles((current) => [...current, ...result.files]);
    if (result.error) {
      toastManager.add({ type: "error", title: "Couldn't attach", description: result.error });
    }
    ref.current?.focus();
  };
  const removeImage = (id: string) =>
    setImages((current) => {
      const gone = current.find((image) => image.id === id);
      if (gone) URL.revokeObjectURL(gone.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  const removeFile = (id: string) =>
    setFiles((current) => current.filter((file) => file.id !== id));
  const onPaste = (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    attachFiles(files);
  };

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const keybindings = useServerKeybindings();
  const shortcutBindings = useMemo(() => withAppShortcutDefaults(keybindings), [keybindings]);
  const [stashMenuOpen, setStashMenuOpen] = useState(false);

  const restoreStashed = (entry: StashedMessage) => {
    if (entry.quotes.length > 0) {
      // Quotes belong to a chat's box: this one has no place for them.
      useComposerStashStore.getState().stash(entry);
      toastManager.add({ type: "info", title: "Open a chat to bring this one back" });
      return;
    }
    if (entry.text) {
      setText((current) => (current.trim() ? `${current.trimEnd()}\n\n${entry.text}` : entry.text));
    }
    attachFiles(entry.files);
    ref.current?.focus();
  };
  const setAside = () => {
    const result = setAsideOrBringBack({
      text,
      files: [...images.map((image) => image.file), ...files.map((file) => file.file)],
      quotes: [],
    });
    if (result.kind === "back") restoreStashed(result.entry);
    if (result.kind === "pick") setStashMenuOpen(true);
    if (result.kind !== "aside") return;
    for (const image of images) URL.revokeObjectURL(image.previewUrl);
    setImages([]);
    setFiles([]);
    setText("");
    ref.current?.focus();
    toastSetAside(result.entry, {
      leftBehind: recording ? "The recording stays here." : null,
      onRestore: (entry) => restoreStashedRef.current(entry),
    });
  };
  const restoreStashedRef = useRef(restoreStashed);
  restoreStashedRef.current = restoreStashed;
  const setAsideRef = useRef(setAside);
  setAsideRef.current = setAside;
  useEffect(() => {
    loadComposerStash();
    return registerStashTarget((entry) => restoreStashedRef.current(entry));
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (resolveShortcutCommand(event, shortcutBindings) !== "composer.stash") return;
      const focused = document.activeElement;
      const typingElsewhere =
        focused instanceof HTMLElement &&
        focused !== ref.current &&
        (focused.isContentEditable || focused.matches("input, textarea, select"));
      if (typingElsewhere) return;
      event.preventDefault();
      setAsideRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcutBindings]);

  const submit = async (options?: { readonly inBackground?: boolean }) => {
    const prompt = text.trim();
    const check = homeSendCheck({
      text: prompt,
      attachments: images.length + files.length,
      recording,
    });
    if (check.kind === "empty" || starting) {
      ref.current?.focus();
      return;
    }
    if (check.kind === "blocked") {
      toastManager.add({ type: "warning", title: check.message });
      ref.current?.focus();
      return;
    }
    setStarting(true);
    try {
      await onStart(prompt, {
        environmentId: targetEnvironmentId,
        folder: folder?.cwd ?? null,
        ...(assistant
          ? {
              assistant: scopeProjectRef(
                assistant.environmentId as EnvironmentId,
                assistant.projectId as ProjectId,
              ),
            }
          : {}),
        modelSelection: picker.selection,
        runtimeMode: pickedRuntimeMode,
        images,
        files,
        ...(recording ? { recordingKey: recording.threadKey } : {}),
        ...(options?.inBackground ? { inBackground: true } : {}),
      });
      // The new chat's draft owns the previews now (no revoke).
      setImages([]);
      setFiles([]);
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
      <div
        className={cn(
          "relative rounded-[20px] border bg-card shadow-xs/5 transition-colors has-focus-visible:border-ring/45",
          dragging && "border-primary border-dashed bg-primary/[0.03]",
        )}
        onDragOver={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          if (!dataTransferHasFolderOrZip(event.dataTransfer)) {
            // Not a project: pictures are attached to the first message.
            attachFiles(Array.from(event.dataTransfer.files));
            return;
          }
          if (!minimal && text.trim()) {
            // A task is typed: don't replace it — the upload becomes the
            // folder this task works in (the chip's "Upload a folder…").
            void readDroppedUploadFiles(event.dataTransfer).then((files) => {
              if (files.length === 0) return;
              openFolderForChat(
                "upload",
                ({ name, folder: cwd }) => {
                  setFolder({ cwd, name });
                  ref.current?.focus();
                },
                { files, environmentId: targetEnvironmentId },
              );
            });
            return;
          }
          onDropProject?.(event.dataTransfer);
        }}
        data-testid="home-composer-box"
      >
        {dragging ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-[20px] bg-card/90 text-sm font-medium text-primary">
            <FolderUpIcon className="size-4" />
            Drop files to attach, or a project folder / .zip
          </div>
        ) : null}
        {recording ? (
          <div className="px-3 pt-3" data-testid="home-recording">
            <RecordingComposerCard item={recording} />
          </div>
        ) : null}
        {images.length > 0 || files.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="home-attachments">
            {files.map((file) => (
              <div
                key={file.id}
                className="relative flex h-14 max-w-48 min-w-0 items-center gap-2 rounded-lg border bg-muted py-1.5 pr-6 pl-2.5"
                title={`${file.name} — saved to Uploads when the chat starts`}
              >
                <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-xs text-foreground/80">{file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(file.id)}
                  aria-label={`Remove ${file.name}`}
                  className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-background/85 text-foreground hover:bg-background"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
            {images.map((image) => (
              <div
                key={image.id}
                className="relative size-14 overflow-hidden rounded-lg border bg-muted"
              >
                <img src={image.previewUrl} alt={image.name} className="size-full object-cover" />
                <button
                  type="button"
                  onClick={() => removeImage(image.id)}
                  aria-label={`Remove ${image.name}`}
                  className="absolute top-0.5 right-0.5 flex size-4 items-center justify-center rounded-full bg-background/85 text-foreground hover:bg-background"
                >
                  <XIcon className="size-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={ref}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const intent = resolveComposerSubmissionIntent({
                event,
                keybindings: shortcutBindings,
                isDraftThread: true,
              });
              void submit({ inBackground: intent === "background" });
            }
          }}
          rows={minimal ? 3 : 2}
          placeholder={assistant ? `Ask ${assistant.profile.name}...` : placeholder}
          aria-label={ariaLabel}
          data-testid="home-composer"
          className={cn(
            "block w-full resize-none bg-transparent px-4 pt-3.5 text-foreground outline-none placeholder:text-muted-foreground/70",
            minimal ? "min-h-[88px] text-base" : "min-h-[64px] text-[15px]",
          )}
        />
        <div className="flex items-center gap-1 px-2.5 pt-1 pb-2.5">
          {
            // The chips never push past the box: on a phone (390) they used to
            // run over its right edge and shove the send button out. They
            // shrink, the permission chip keeps only its icon, and anything
            // still too wide scrolls inside the row (same as the chat composer).
            // The first screen shows the model and its reasoning too (Misha
            // 28.10, P2: "why can't I pick?") — folder and permissions stay off.
            <div
              className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              data-testid="home-composer-chips"
            >
              {assistant ? (
                // An assistant's chat runs on its own computer, nothing to pick.
                assistantComputer ? (
                  <span
                    className="shrink-0 px-2 text-xs text-muted-foreground"
                    data-testid="home-assistant-computer"
                  >
                    {assistantComputer}
                  </span>
                ) : null
              ) : spacesOn || (minimal && !severalComputers) ? null : (
                <NewChatComputerPicker
                  variant="chip"
                  environmentId={targetEnvironmentId}
                  onPick={(next) => {
                    pickComputer(next);
                    ref.current?.focus();
                  }}
                  testId="home-computer-chip"
                />
              )}
              {minimal ? null : (
                <NewChatFolderPicker
                  variant="chip"
                  environmentId={targetEnvironmentId}
                  folder={folder}
                  assistants={assistants}
                  assistant={assistant}
                  onPickAssistant={(member) => {
                    setAssistant(member);
                    ref.current?.focus();
                  }}
                  onPick={(next) => {
                    // A folder the picker just made is a project already; the
                    // chat finds it by path when the task starts.
                    setFolder(next);
                    setAssistant(null);
                    ref.current?.focus();
                  }}
                  testId="home-folder-chip"
                />
              )}
              {picker.selection && !assistant ? (
                <ProviderModelPicker
                  compact
                  activeInstanceId={picker.selection.instanceId}
                  model={picker.selection.model}
                  lockedProvider={null}
                  instanceEntries={picker.instanceEntries}
                  environmentId={targetEnvironmentId}
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
              ) : modelChipPending && targetEnvironmentId !== null ? (
                <Skeleton
                  className="h-8 w-36 shrink-0 rounded-full sm:h-7"
                  data-testid="home-model-chip-pending"
                />
              ) : null}
              {picker.selection && selectedEntry && !assistant ? (
                <TraitsPicker
                  provider={selectedEntry.driverKind}
                  models={selectedEntry.models}
                  model={picker.selection.model}
                  modelOptions={picker.selection.options}
                  prompt={text}
                  onPromptChange={setText}
                  onModelOptionsChange={picker.setOptions}
                  triggerVariant="ghost"
                  triggerClassName="h-7 rounded-full text-xs"
                />
              ) : null}
              {minimal || assistant ? null : (
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
                    <span className="hidden min-[440px]:inline">
                      <SelectValue>{PERMISSION_MODES[runtimeMode].label}</SelectValue>
                    </span>
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
              )}
            </div>
          }
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            data-testid="home-attach-input"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              attachFiles(files);
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            title="Attach files or pictures — or paste a screenshot"
            data-testid="home-attach"
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PaperclipIcon className="size-4" />
          </button>
          {dictationSupported ? (
            <button
              type="button"
              onClick={() => {
                if (dictation.state === "recording") dictation.stop();
                else if (dictation.state === "idle") void dictation.start();
              }}
              disabled={dictation.state === "transcribing"}
              aria-label={dictationLabel}
              title={dictationLabel}
              data-testid="home-dictate"
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                dictation.state === "recording" && "animate-pulse text-red-500 hover:text-red-500",
              )}
            >
              {dictation.state === "transcribing" ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : dictation.state === "recording" ? (
                <SquareIcon className="size-4 fill-current" />
              ) : (
                <MicIcon className="size-4" />
              )}
            </button>
          ) : null}
          {recordingSupported && recordingKey ? (
            // The same recording as "Show the agent" below, in the box itself
            // (as in the chat's composer).
            <RecordButton threadKey={recordingKey} environmentId={environmentId} />
          ) : null}
          <ComposerStashMenu
            open={stashMenuOpen}
            onOpenChange={setStashMenuOpen}
            onRestore={restoreStashed}
          />
          <button
            type="button"
            onClick={() => void submit()}
            aria-label="Start"
            disabled={starting}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
              text.trim() || images.length > 0 || files.length > 0 || recording
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            {starting ? <Spinner className="size-4" /> : <ArrowUpIcon className="size-4" />}
          </button>
        </div>
      </div>
      {minimal ? null : (
        <HomePlanRoomLine
          environmentId={targetEnvironmentId}
          driver={selectedEntry?.driverKind ?? null}
          onPickComputer={pickComputer}
        />
      )}
      {starters.length > 0 || onUploadProject || (recordingSupported && recordingKey) ? (
        // One row of light pills; on a narrow screen they wrap (no sideways scroll).
        <div
          className={cn("flex flex-wrap gap-2", minimal && "justify-center")}
          data-testid="home-starters"
        >
          {starters.map((starter) => (
            <button
              key={starter.id}
              type="button"
              title={starter.prompt}
              onClick={() => {
                if (onStarter?.(starter.id)) return;
                setText(starter.prompt);
                if (starter.folder) setFolder(starter.folder);
                const input = ref.current;
                if (input) {
                  input.focus();
                  // Caret at the end, so they can keep typing.
                  requestAnimationFrame(() =>
                    input.setSelectionRange(input.value.length, input.value.length),
                  );
                }
              }}
              className={PILL}
              data-testid="home-starter"
            >
              <span className="truncate">{starter.label}</span>
            </button>
          ))}
          {onUploadProject ? (
            <button
              type="button"
              onClick={onUploadProject}
              className={PILL}
              data-testid="home-upload-project"
            >
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              Add a project
            </button>
          ) : null}
          {recordingSupported && recordingKey ? (
            <RecordButton
              threadKey={recordingKey}
              environmentId={environmentId}
              chip={{ className: PILL, testId: "home-show-agent" }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The pill under the box — the same look for every hint and "I have a project". */
const PILL =
  "inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-3.5 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none";
