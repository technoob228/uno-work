import {
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { memo, useMemo, useState, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { SearchIcon } from "lucide-react";
import { ModelListRow } from "./ModelListRow";
import { modelCannotRunCodingAgent, modelMatchesCapabilityFilter } from "./modelCapabilities";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { isModelPickerNewModel } from "./modelPickerModelHighlights";
import {
  createModelPickerSearchIndex,
  getModelPickerSearchTokens,
  scoreModelPickerSearchIndex,
  type ModelPickerSearchIndex,
} from "./modelPickerSearch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxList,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { Button } from "../ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
} from "../ui/select";
import { ModelEsque, PROVIDER_ICON_BY_PROVIDER } from "./providerIconUtils";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { TooltipProvider } from "../ui/tooltip";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import {
  useModelPickerFilterStore,
  type UnoCapabilityFilter,
  type UnoSortMode,
  type UnoTierFilter,
} from "./modelPickerFilterState";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  capabilities?: ModelEsque["capabilities"];
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  continuationGroupKey?: string | undefined;
  searchIndex: ModelPickerSearchIndex;
};

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_PICKER_VIRTUALIZE_THRESHOLD = 80;
const UNO_TIER_RANK: Record<Exclude<UnoTierFilter, "all">, number> = {
  frontier: 0,
  strong: 1,
  cheap: 2,
};
const UNO_TIER_FILTER_OPTIONS = [
  { value: "all", label: "All tiers" },
  { value: "frontier", label: "Frontier" },
  { value: "strong", label: "Strong" },
  { value: "cheap", label: "Average" },
] as const satisfies ReadonlyArray<{ value: UnoTierFilter; label: string }>;
const UNO_SORT_OPTIONS = [
  { value: "recommended", label: "Recommended" },
  { value: "price-asc", label: "Price low-high" },
  { value: "price-desc", label: "Price high-low" },
  { value: "tier", label: "Tier best-first" },
] as const satisfies ReadonlyArray<{ value: UnoSortMode; label: string }>;
const UNO_CAPABILITY_FILTER_OPTIONS = [
  { value: "tools", label: "Tools" },
  { value: "image-input", label: "Image input" },
  { value: "image-output", label: "Image generation" },
  { value: "streaming", label: "Streaming" },
] as const satisfies ReadonlyArray<{ value: UnoCapabilityFilter; label: string }>;
const UNO_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  ai21: "AI21",
  anthropic: "Anthropic",
  baidu: "Baidu",
  bytedance: "ByteDance",
  cohere: "Cohere",
  deepseek: "DeepSeek",
  google: "Google",
  groq: "Groq",
  "ibm-granite": "IBM Granite",
  liquid: "Liquid",
  "meta-llama": "Meta Llama",
  microsoft: "Microsoft",
  mistralai: "Mistral",
  moonshotai: "Moonshot AI",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  perplexity: "Perplexity",
  qwen: "Qwen",
  xai: "xAI",
  "x-ai": "xAI",
};

// Split a `${instanceId}:${slug}` combobox key back into its pieces. Slugs
// can contain colons (e.g. some vendor model ids), so we only split on the
// first colon — anything after that is the slug.
function splitInstanceModelKey(key: string): { instanceId: ProviderInstanceId; slug: string } {
  const colonIndex = key.indexOf(":");
  if (colonIndex === -1) {
    return { instanceId: key as ProviderInstanceId, slug: "" };
  }
  return {
    instanceId: key.slice(0, colonIndex) as ProviderInstanceId,
    slug: key.slice(colonIndex + 1),
  };
}

function unoModelEstimatedCost(model: Pick<ModelPickerItem, "capabilities">): number | null {
  const cost = model.capabilities?.metadata?.pricing?.estimatedSeriousTaskUsd;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

function unoModelMatchesCapability(
  model: Pick<ModelPickerItem, "capabilities">,
  capability: UnoCapabilityFilter,
): boolean {
  return modelMatchesCapabilityFilter(model.capabilities, capability);
}

function modelIsSelectableForCodingAgent(
  model: Pick<ModelPickerItem, "driverKind" | "capabilities">,
  options?: { readonly allowImageGenerationModels?: boolean },
): boolean {
  if (options?.allowImageGenerationModels === true) return true;
  return model.driverKind !== "uno" || !modelCannotRunCodingAgent(model.capabilities);
}

function unoModelTierRank(model: Pick<ModelPickerItem, "capabilities" | "name">): number {
  const tier = model.capabilities?.metadata?.tier;
  return tier === "frontier" || tier === "strong" || tier === "cheap"
    ? UNO_TIER_RANK[tier]
    : Number.POSITIVE_INFINITY;
}

function compareUnoModelsBySortMode(
  sortMode: UnoSortMode,
): (left: ModelPickerItem, right: ModelPickerItem) => number {
  return (left, right) => {
    if (sortMode === "recommended") return 0;
    if (sortMode === "tier") {
      const delta = unoModelTierRank(left) - unoModelTierRank(right);
      return delta === 0 ? left.name.localeCompare(right.name) : delta;
    }
    const leftCost = unoModelEstimatedCost(left);
    const rightCost = unoModelEstimatedCost(right);
    if (leftCost === null && rightCost === null) return left.name.localeCompare(right.name);
    if (leftCost === null) return 1;
    if (rightCost === null) return -1;
    const delta = sortMode === "price-asc" ? leftCost - rightCost : rightCost - leftCost;
    return delta === 0 ? left.name.localeCompare(right.name) : delta;
  };
}

function formatUnoProviderLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  const known = UNO_PROVIDER_LABELS[normalized];
  if (known) return known;
  return provider
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatUnoTierFilterLabel(value: UnoTierFilter): string {
  return UNO_TIER_FILTER_OPTIONS.find((option) => option.value === value)?.label ?? "All tiers";
}

function formatUnoSortModeLabel(value: UnoSortMode): string {
  return UNO_SORT_OPTIONS.find((option) => option.value === value)?.label ?? "Recommended";
}

function formatUnoCapabilityFilterLabel(filters: ReadonlyArray<UnoCapabilityFilter>): string {
  if (filters.length === 0) return "Any";
  if (filters.length === 1) {
    return (
      UNO_CAPABILITY_FILTER_OPTIONS.find((option) => option.value === filters[0])?.label ??
      "Selected"
    );
  }
  if (filters.length === 2) {
    return filters
      .map(
        (filter) =>
          UNO_CAPABILITY_FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? filter,
      )
      .join(" + ");
  }
  return `${filters.length} selected`;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Multiple instances of the same kind
   * remain selectable (e.g. locked to `codex` still lets the user switch
   * between the default Codex and a custom Codex Personal).
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /**
   * All configured provider instances in display order. Used to render
   * the sidebar (one button per instance) and to resolve display names
   * for the locked-mode header.
   */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  /**
   * Model options per instance. Keyed by `ProviderInstanceId` so the
   * default Codex instance and any custom Codex instances each have their
   * own list (custom instances typically start with the same built-in
   * model set but are free to diverge via customModels).
   */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  allowImageGenerationModels?: boolean;
  onRequestClose?: () => void;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    onInstanceModelChange,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRegionRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const favorites = useSettings((s) => s.favorites ?? []);
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    () => {
      if (props.lockedProvider !== null) {
        // When locked, prime the sidebar to the currently-active instance
        // so jumping into the picker keeps the focused instance visible.
        return props.activeInstanceId;
      }
      return favorites.length > 0 ? "favorites" : props.activeInstanceId;
    },
  );
  const keybindings = useMemo<ResolvedKeybindingsConfig>(
    () => providedKeybindings ?? [],
    [providedKeybindings],
  );
  const { updateSettings } = useUpdateSettings();
  const unoTierFilter = useModelPickerFilterStore((state) => state.unoTierFilter);
  const unoCapabilityFilters = useModelPickerFilterStore((state) => state.unoCapabilityFilters);
  const unoProviderFilter = useModelPickerFilterStore((state) => state.unoProviderFilter);
  const unoSortMode = useModelPickerFilterStore((state) => state.unoSortMode);
  const setUnoTierFilter = useModelPickerFilterStore((state) => state.setUnoTierFilter);
  const setUnoCapabilityFilters = useModelPickerFilterStore(
    (state) => state.setUnoCapabilityFilters,
  );
  const setUnoProviderFilter = useModelPickerFilterStore((state) => state.setUnoProviderFilter);
  const setUnoSortMode = useModelPickerFilterStore((state) => state.setUnoSortMode);

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const searchTokens = useMemo(() => getModelPickerSearchTokens(searchQuery), [searchQuery]);

  const handleSelectInstance = useCallback(
    (instanceId: ProviderInstanceId | "favorites") => {
      setSelectedInstanceId(instanceId);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Create a Set for efficient lookup. Favorites are keyed by
  // `${instanceId}:${slug}`; the storage schema widened from ProviderDriverKind
  // to ProviderInstanceId so pre-migration favorites keyed by driver slugs
  // (e.g. `"codex:gpt-5"`) still resolve — the default instance id equals
  // the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);

  /**
   * Lookup table keyed by `instanceId`. Used for display name + driver
   * kind enrichment and for `ready`/enabled filtering before flattening
   * models into the search list.
   */
  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  const readyInstanceSet = useMemo(() => {
    const ready = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (entry.status === "ready") {
        ready.add(entry.instanceId);
      }
    }
    return ready;
  }, [instanceEntries]);

  // Flatten models into a searchable array. One pass over the
  // instance-keyed map; each model carries its instance id + driver kind
  // so the list row can render the right icon and display name without
  // another lookup.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        // Instance disappeared between renders (configuration change). Skip
        // its models — stale options shouldn't appear in the picker.
        continue;
      }
      if (!readyInstanceSet.has(instanceId)) {
        continue;
      }
      for (const model of models) {
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.capabilities ? { capabilities: model.capabilities } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
          searchIndex: createModelPickerSearchIndex({
            name: model.name,
            ...(model.shortName ? { shortName: model.shortName } : {}),
            ...(model.subProvider ? { subProvider: model.subProvider } : {}),
            driverKind: entry.driverKind,
            providerDisplayName: entry.displayName,
          }),
        });
      }
    }
    return out;
  }, [modelOptionsByInstance, entryByInstanceId, readyInstanceSet]);

  const isLocked = props.lockedProvider !== null;
  const isSearching = searchTokens.length > 0;
  const lockedInstanceEntries = useMemo(
    () =>
      props.lockedProvider ? instanceEntries.filter((entry) => matchesLockedProvider(entry)) : [],
    [instanceEntries, matchesLockedProvider, props.lockedProvider],
  );
  const showLockedInstanceSidebar = isLocked && lockedInstanceEntries.length > 1;
  const showSidebar = !isSearching && (!isLocked || showLockedInstanceSidebar);
  const sidebarInstanceEntries = showLockedInstanceSidebar
    ? lockedInstanceEntries
    : instanceEntries;
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );
  const selectedInstanceEntry =
    selectedInstanceId === "favorites" ? null : (entryByInstanceId.get(selectedInstanceId) ?? null);
  const showUnoFilters =
    selectedInstanceEntry?.driverKind === "uno" ||
    (isSearching && flatModels.some((model) => model.driverKind === "uno"));
  const unoProviderOptions = useMemo(
    () =>
      Array.from(
        new Set(
          flatModels
            .filter((model) => model.driverKind === "uno")
            .map((model) => model.subProvider?.trim())
            .filter((value): value is string => Boolean(value)),
        ),
      ).toSorted((left, right) => left.localeCompare(right)),
    [flatModels],
  );
  const unoProviderFilterItems = useMemo(
    () => [
      { value: "all", label: "All providers" },
      ...unoProviderOptions.map((provider) => ({
        value: provider,
        label: formatUnoProviderLabel(provider),
      })),
    ],
    [unoProviderOptions],
  );
  const hasActiveUnoFilters =
    unoProviderFilter !== "all" || unoTierFilter !== "all" || unoCapabilityFilters.length > 0;
  const unoCapabilityCounts = useMemo(() => {
    const counts = new Map<UnoCapabilityFilter, number>(
      UNO_CAPABILITY_FILTER_OPTIONS.map((option) => [option.value, 0] as const),
    );
    for (const model of flatModels) {
      if (model.driverKind !== "uno") continue;
      if (unoProviderFilter !== "all" && model.subProvider !== unoProviderFilter) continue;
      const metadata = model.capabilities?.metadata;
      if (unoTierFilter !== "all" && metadata?.tier !== unoTierFilter) continue;
      for (const option of UNO_CAPABILITY_FILTER_OPTIONS) {
        if (!unoModelMatchesCapability(model, option.value)) continue;
        counts.set(option.value, (counts.get(option.value) ?? 0) + 1);
      }
    }
    return counts;
  }, [flatModels, unoProviderFilter, unoTierFilter]);

  const toggleUnoCapabilityFilter = useCallback(
    (capability: UnoCapabilityFilter) => {
      const current = useModelPickerFilterStore.getState().unoCapabilityFilters;
      setUnoCapabilityFilters(
        current.includes(capability)
          ? current.filter((entry) => entry !== capability)
          : [...current, capability],
      );
    },
    [setUnoCapabilityFilters],
  );

  useEffect(() => {
    if (unoProviderFilter !== "all" && !unoProviderOptions.includes(unoProviderFilter)) {
      setUnoProviderFilter("all");
    }
  }, [setUnoProviderFilter, unoProviderFilter, unoProviderOptions]);

  const matchesUnoFilters = useCallback(
    (model: ModelPickerItem): boolean => {
      if (model.driverKind !== "uno") {
        return !showUnoFilters || !hasActiveUnoFilters;
      }
      const metadata = model.capabilities?.metadata;
      if (unoTierFilter !== "all" && metadata?.tier !== unoTierFilter) return false;
      if (unoProviderFilter !== "all" && model.subProvider !== unoProviderFilter) return false;
      if (
        unoCapabilityFilters.length > 0 &&
        !unoCapabilityFilters.every((capability) => unoModelMatchesCapability(model, capability))
      ) {
        return false;
      }
      return true;
    },
    [hasActiveUnoFilters, showUnoFilters, unoCapabilityFilters, unoProviderFilter, unoTierFilter],
  );

  // Filter models based on search query and selected instance
  const filteredModels = useMemo(() => {
    let result = flatModels.filter(matchesUnoFilters);

    // Apply tokenized fuzzy search across the combined provider/model search fields.
    if (searchTokens.length > 0) {
      const rankedMatches = result
        .map((model) => {
          const modelKey = providerModelKey(model.instanceId, model.slug);
          const isFavorite = favoritesSet.has(modelKey);
          return {
            model,
            score: scoreModelPickerSearchIndex(model.searchIndex, searchTokens, { isFavorite }),
            isFavorite,
            tieBreaker: model.searchIndex.tieBreaker,
          };
        })
        .filter(
          (
            rankedModel,
          ): rankedModel is {
            model: ModelPickerItem;
            score: number;
            isFavorite: boolean;
            tieBreaker: string;
          } => rankedModel.score !== null,
        );

      // When searching, we only respect locked provider (by driver kind),
      // ignoring sidebar selection so account-scoped searches can find a
      // model before the user chooses a specific instance rail item.
      if (props.lockedProvider !== null) {
        return rankedMatches
          .filter((rankedModel) => matchesLockedProvider(rankedModel.model))
          .toSorted((a, b) => {
            const scoreDelta = a.score - b.score;
            if (scoreDelta !== 0) {
              return scoreDelta;
            }
            if (a.isFavorite !== b.isFavorite) {
              return a.isFavorite ? -1 : 1;
            }
            return a.tieBreaker.localeCompare(b.tieBreaker);
          })
          .map((rankedModel) => rankedModel.model);
      }

      return rankedMatches
        .toSorted((a, b) => {
          const scoreDelta = a.score - b.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }
          if (a.isFavorite !== b.isFavorite) {
            return a.isFavorite ? -1 : 1;
          }
          return a.tieBreaker.localeCompare(b.tieBreaker);
        })
        .map((rankedModel) => rankedModel.model);
    }

    if (props.lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
      if (showLockedInstanceSidebar) {
        result = result.filter((m) => m.instanceId === selectedInstanceId);
      }
    } else if (selectedInstanceId === "favorites") {
      result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }

    const sorted = sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      instanceOrder: selectedInstanceId === "favorites" ? instanceOrder : [],
    });
    if (!showUnoFilters || unoSortMode === "recommended") {
      return sorted;
    }
    const compareUnoModels = compareUnoModelsBySortMode(unoSortMode);
    return sorted.toSorted((left, right) => {
      if (left.driverKind !== "uno" || right.driverKind !== "uno") return 0;
      return compareUnoModels(left, right);
    });
  }, [
    favoritesSet,
    flatModels,
    instanceOrder,
    matchesLockedProvider,
    props.lockedProvider,
    searchTokens,
    showLockedInstanceSidebar,
    selectedInstanceId,
    matchesUnoFilters,
    showUnoFilters,
    unoSortMode,
  ]);

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId) => {
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      const requestedModel = options.find((option) => option.slug === modelSlug);
      if (
        requestedModel &&
        entry.driverKind === "uno" &&
        modelCannotRunCodingAgent(requestedModel.capabilities) &&
        props.allowImageGenerationModels !== true
      ) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        const selectedModel = options.find((option) => option.slug === resolvedModel);
        if (
          selectedModel &&
          entry.driverKind === "uno" &&
          modelCannotRunCodingAgent(selectedModel.capabilities) &&
          props.allowImageGenerationModels !== true
        ) {
          return;
        }
        onInstanceModelChange(instanceId, resolvedModel);
        const route = selectedModel?.capabilities?.metadata?.defaultRoute;
        if (entry.driverKind === "uno" && (route === "default" || route === "russia")) {
          updateSettings({ unoLastModelRoute: route });
        }
      }
    },
    [
      entryByInstanceId,
      modelOptionsByInstance,
      onInstanceModelChange,
      props.allowImageGenerationModels,
      updateSettings,
    ],
  );

  const toggleFavorite = useCallback(
    (instanceId: ProviderInstanceId, model: string) => {
      const newFavorites = [...favorites];
      const index = newFavorites.findIndex((f) => f.provider === instanceId && f.model === model);
      if (index >= 0) {
        newFavorites.splice(index, 1);
      } else {
        newFavorites.push({ provider: instanceId, model });
      }
      updateSettings({ favorites: newFavorites });
    },
    [favorites, updateSettings],
  );

  const LockedProviderIcon =
    isLocked && props.lockedProvider ? PROVIDER_ICON_BY_PROVIDER[props.lockedProvider] : null;
  // Header label for locked mode. Use the active instance's displayName
  // when the lock narrows to exactly one instance (so "Codex Personal"
  // shows instead of the generic driver label); fall back to the first
  // matching entry otherwise.
  const lockedHeaderLabel = useMemo(() => {
    if (!isLocked || !props.lockedProvider) return null;
    const matches = instanceEntries.filter((entry) => matchesLockedProvider(entry));
    if (matches.length === 0) return null;
    const active = matches.find((entry) => entry.instanceId === props.activeInstanceId);
    return (active ?? matches[0])?.displayName ?? null;
  }, [
    isLocked,
    matchesLockedProvider,
    props.lockedProvider,
    props.activeInstanceId,
    instanceEntries,
  ]);
  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    for (const [visibleModelIndex, model] of filteredModels
      .filter((model) =>
        modelIsSelectableForCodingAgent(model, {
          allowImageGenerationModels: props.allowImageGenerationModels === true,
        }),
      )
      .entries()) {
      const jumpCommand = modelPickerJumpCommandForIndex(visibleModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(`${model.instanceId}:${model.slug}`, jumpCommand);
    }
    return mapping;
  }, [filteredModels, props.allowImageGenerationModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allModelKeys = useMemo(
    (): string[] => flatModels.map((model) => `${model.instanceId}:${model.slug}`),
    [flatModels],
  );
  const filteredModelKeys = useMemo(
    (): string[] => filteredModels.map((model) => `${model.instanceId}:${model.slug}`),
    [filteredModels],
  );
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(filteredModels.map((model) => [`${model.instanceId}:${model.slug}`, model] as const)),
    [filteredModels],
  );
  const shouldVirtualizeModelList = filteredModelKeys.length > MODEL_PICKER_VIRTUALIZE_THRESHOLD;
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (!targetModelKey) {
        return;
      }
      const { instanceId, slug } = splitInstanceModelKey(targetModelKey);
      event.preventDefault();
      event.stopPropagation();
      handleModelSelect(slug, instanceId);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [handleModelSelect, keybindings, modelJumpModelKeys, modelJumpShortcutContext]);

  useEffect(() => {
    if (!shouldVirtualizeModelList) {
      return;
    }
    modelListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
  }, [filteredModelKeys, shouldVirtualizeModelList]);

  useLayoutEffect(() => {
    if (shouldVirtualizeModelList) {
      return;
    }
    const listRegion = listRegionRef.current;
    if (!listRegion) {
      return;
    }

    let cancelled = false;
    let frame = 0;
    let nestedFrame = 0;
    let timeout = 0;

    const measureScrollArea = () => {
      if (cancelled) {
        return;
      }
      const viewport = listRegion.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
      if (!viewport || viewport.scrollHeight <= viewport.clientHeight) {
        return;
      }
      const originalScrollTop = viewport.scrollTop;
      const maxScrollTop = viewport.scrollHeight - viewport.clientHeight;
      if (maxScrollTop <= 0) {
        return;
      }
      viewport.scrollTop = Math.min(originalScrollTop + 1, maxScrollTop);
      viewport.scrollTop = originalScrollTop;
    };

    queueMicrotask(measureScrollArea);
    frame = window.requestAnimationFrame(() => {
      measureScrollArea();
      nestedFrame = window.requestAnimationFrame(measureScrollArea);
    });
    timeout = window.setTimeout(measureScrollArea, 0);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
      window.clearTimeout(timeout);
    };
  }, [filteredModelKeys, shouldVirtualizeModelList]);

  const renderModelRow = useCallback(
    (modelKey: string, index: number) => {
      const model = filteredModelByKey.get(modelKey);
      if (!model) {
        return null;
      }
      const disabledReason = modelIsSelectableForCodingAgent(model, {
        allowImageGenerationModels: props.allowImageGenerationModels === true,
      })
        ? null
        : "This model cannot run Build or Plan turns because it does not support tools.";
      return (
        <ModelListRow
          key={modelKey}
          index={index}
          model={model}
          instanceId={model.instanceId}
          driverKind={model.driverKind}
          providerDisplayName={model.instanceDisplayName}
          providerAccentColor={model.instanceAccentColor}
          isFavorite={favoritesSet.has(modelKey)}
          showProvider={!isLocked || showLockedInstanceSidebar}
          preferShortName={!isLocked}
          useTriggerLabel={isLocked && !showLockedInstanceSidebar}
          showNewBadge={isModelPickerNewModel(model.driverKind, model.slug)}
          jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
          disabled={disabledReason !== null}
          disabledReason={disabledReason}
          onToggleFavorite={() => toggleFavorite(model.instanceId, model.slug)}
        />
      );
    },
    [
      favoritesSet,
      filteredModelByKey,
      isLocked,
      modelJumpLabelByKey,
      props.allowImageGenerationModels,
      showLockedInstanceSidebar,
      toggleFavorite,
    ],
  );

  return (
    <TooltipProvider delay={0}>
      <div
        className={cn(
          "relative flex h-screen max-h-96 w-screen max-w-100 overflow-hidden rounded-lg border bg-popover not-dark:bg-clip-padding text-popover-foreground shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
          isLocked && !showLockedInstanceSidebar ? "flex-col" : "flex-row",
        )}
      >
        {/* Locked provider header (only shown in locked mode) */}
        {isLocked && !showLockedInstanceSidebar && LockedProviderIcon && lockedHeaderLabel && (
          <div className="flex items-center gap-2 px-4 py-3 border-b">
            <LockedProviderIcon className="size-5 shrink-0" />
            <span className="font-medium text-sm">{lockedHeaderLabel}</span>
          </div>
        )}

        {/* Sidebar (only in unlocked mode) */}
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            instanceEntries={sidebarInstanceEntries}
            showFavorites={!isLocked}
            showComingSoon={!isLocked}
          />
        )}

        {/* Main content area */}
        <Combobox
          inline
          items={allModelKeys}
          filteredItems={filteredModelKeys}
          filter={null}
          autoHighlight
          virtualized={shouldVirtualizeModelList}
          open
          value={`${props.activeInstanceId}:${props.model}`}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (
              shouldVirtualizeModelList &&
              eventDetails.reason === "keyboard" &&
              eventDetails.index >= 0
            ) {
              modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(modelKey) => {
            if (typeof modelKey !== "string") {
              return;
            }
            const { instanceId, slug } = splitInstanceModelKey(modelKey);
            handleModelSelect(slug, instanceId);
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden",
              isLocked && !showLockedInstanceSidebar ? "min-w-0" : showSidebar && "border-l",
            )}
          >
            {/* Search bar */}
            <div className="border-b px-3 py-2">
              <ComboboxInput
                ref={searchInputRef}
                className="[&_input]:font-sans rounded-md"
                inputClassName="border-0 shadow-none ring-0 focus-visible:ring-0"
                placeholder="Search models..."
                showTrigger={false}
                startAddon={<SearchIcon className="size-4 shrink-0 text-muted-foreground/50" />}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    props.onRequestClose?.();
                    return;
                  }
                  if (e.key === "Enter" && highlightedModelKeyRef.current) {
                    (
                      e as typeof e & { preventBaseUIHandler?: () => void }
                    ).preventBaseUIHandler?.();
                    e.preventDefault();
                    e.stopPropagation();
                    const { instanceId, slug } = splitInstanceModelKey(
                      highlightedModelKeyRef.current,
                    );
                    handleModelSelect(slug, instanceId);
                    return;
                  }
                  e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onTouchStart={(e) => e.stopPropagation()}
                size="sm"
              />
              {showUnoFilters ? (
                <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px] sm:grid-cols-4">
                  <Select
                    modal={false}
                    value={unoProviderFilter}
                    onValueChange={(value) => {
                      if (typeof value === "string") {
                        setUnoProviderFilter(value);
                      }
                    }}
                    items={unoProviderFilterItems}
                  >
                    <SelectTrigger
                      size="xs"
                      className={cn(
                        "h-7 min-w-0 border-border/70 text-[10px] text-muted-foreground",
                        unoProviderFilter !== "all" &&
                          "border-foreground/30 bg-muted text-foreground",
                      )}
                      aria-label="Provider filter"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-muted-foreground/70">Provider</span>{" "}
                        {unoProviderFilter === "all"
                          ? "All"
                          : formatUnoProviderLabel(unoProviderFilter)}
                      </span>
                    </SelectTrigger>
                    <SelectPopup className="max-h-72">
                      <SelectGroup>
                        <SelectGroupLabel>Provider</SelectGroupLabel>
                        <SelectItem value="all">All providers</SelectItem>
                        {unoProviderOptions.map((provider) => (
                          <SelectItem key={provider} value={provider}>
                            {formatUnoProviderLabel(provider)}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectPopup>
                  </Select>

                  <Menu>
                    <MenuTrigger
                      render={
                        <Button
                          size="xs"
                          variant="outline"
                          className={cn(
                            "h-7 min-w-0 justify-start border-border/70 px-2 text-[10px] text-muted-foreground",
                            unoCapabilityFilters.length > 0 &&
                              "border-foreground/30 bg-muted text-foreground",
                          )}
                          aria-label="Capabilities filter"
                        />
                      }
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-muted-foreground/70">Capabilities</span>{" "}
                        {formatUnoCapabilityFilterLabel(unoCapabilityFilters)}
                      </span>
                    </MenuTrigger>
                    <MenuPopup align="start" className="w-52">
                      <MenuItem onClick={() => setUnoCapabilityFilters([])}>
                        Any capabilities
                      </MenuItem>
                      <MenuSeparator />
                      {UNO_CAPABILITY_FILTER_OPTIONS.map((option) => {
                        const count = unoCapabilityCounts.get(option.value) ?? 0;
                        const checked = unoCapabilityFilters.includes(option.value);
                        return (
                          <MenuCheckboxItem
                            key={option.value}
                            checked={checked}
                            disabled={count === 0 && !checked}
                            onCheckedChange={() => toggleUnoCapabilityFilter(option.value)}
                          >
                            <span className="flex min-w-0 items-center justify-between gap-3">
                              <span className="truncate">{option.label}</span>
                              <span
                                className={cn(
                                  "shrink-0 text-xs tabular-nums text-muted-foreground/65",
                                  checked && "text-foreground",
                                )}
                              >
                                {count}
                              </span>
                            </span>
                          </MenuCheckboxItem>
                        );
                      })}
                    </MenuPopup>
                  </Menu>

                  <Select
                    modal={false}
                    value={unoTierFilter}
                    onValueChange={(value) => {
                      if (
                        value === "all" ||
                        value === "frontier" ||
                        value === "strong" ||
                        value === "cheap"
                      ) {
                        setUnoTierFilter(value);
                      }
                    }}
                    items={UNO_TIER_FILTER_OPTIONS}
                  >
                    <SelectTrigger
                      size="xs"
                      className={cn(
                        "h-7 min-w-0 border-border/70 text-[10px] text-muted-foreground",
                        unoTierFilter !== "all" && "border-foreground/30 bg-muted text-foreground",
                      )}
                      aria-label="Tier filter"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-muted-foreground/70">Tier</span>{" "}
                        {formatUnoTierFilterLabel(unoTierFilter)}
                      </span>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectGroup>
                        <SelectGroupLabel>Tier</SelectGroupLabel>
                        {UNO_TIER_FILTER_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectPopup>
                  </Select>

                  <Select
                    modal={false}
                    value={unoSortMode}
                    onValueChange={(value) => {
                      if (
                        value === "recommended" ||
                        value === "price-asc" ||
                        value === "price-desc" ||
                        value === "tier"
                      ) {
                        setUnoSortMode(value);
                      }
                    }}
                    items={UNO_SORT_OPTIONS}
                  >
                    <SelectTrigger
                      size="xs"
                      className={cn(
                        "h-7 min-w-0 border-border/70 text-[10px] text-muted-foreground",
                        unoSortMode !== "recommended" &&
                          "border-foreground/30 bg-muted text-foreground",
                      )}
                      aria-label="Sort models"
                    >
                      <span className="min-w-0 truncate">
                        <span className="text-muted-foreground/70">Sort</span>{" "}
                        {formatUnoSortModeLabel(unoSortMode)}
                      </span>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectGroup>
                        <SelectGroupLabel>Sort</SelectGroupLabel>
                        {UNO_SORT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
            </div>

            {/* Model list */}
            <div
              ref={listRegionRef}
              className="relative min-h-0 flex-1 before:pointer-events-none before:absolute before:inset-0 before:bg-muted/40"
            >
              {shouldVirtualizeModelList ? (
                <ComboboxListVirtualized className="model-picker-list size-full divide-y px-2 py-1">
                  <LegendList<string>
                    ref={modelListRef}
                    data={filteredModelKeys}
                    keyExtractor={(modelKey) => modelKey}
                    renderItem={({ item, index }) => renderModelRow(item, index)}
                    estimatedItemSize={64}
                    drawDistance={512}
                    style={{ height: "100%" }}
                  />
                </ComboboxListVirtualized>
              ) : (
                <ComboboxList className="model-picker-list size-full divide-y px-2 py-1">
                  {filteredModelKeys.map((modelKey, index) => renderModelRow(modelKey, index))}
                </ComboboxList>
              )}
            </div>
            <ComboboxEmpty className="not-empty:py-6 empty:h-0 text-xs font-normal leading-snug">
              No models found
            </ComboboxEmpty>
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
