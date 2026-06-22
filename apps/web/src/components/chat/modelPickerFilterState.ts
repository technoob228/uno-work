import { create } from "zustand";
import type { ModelCapabilityFilter } from "./modelCapabilities";

export type UnoTierFilter = "all" | "frontier" | "strong" | "cheap";
export type UnoCapabilityFilter = ModelCapabilityFilter;
export type UnoSortMode = "recommended" | "price-asc" | "price-desc" | "tier";

type ModelPickerFilterState = {
  unoTierFilter: UnoTierFilter;
  unoCapabilityFilters: readonly UnoCapabilityFilter[];
  unoProviderFilter: string;
  unoSortMode: UnoSortMode;
  setUnoTierFilter: (value: UnoTierFilter) => void;
  setUnoCapabilityFilters: (value: readonly UnoCapabilityFilter[]) => void;
  setUnoProviderFilter: (value: string) => void;
  setUnoSortMode: (value: UnoSortMode) => void;
};

const DEFAULT_MODEL_PICKER_FILTER_STATE = {
  unoTierFilter: "all",
  unoCapabilityFilters: [],
  unoProviderFilter: "all",
  unoSortMode: "recommended",
} as const;

export const useModelPickerFilterStore = create<ModelPickerFilterState>((set) => ({
  ...DEFAULT_MODEL_PICKER_FILTER_STATE,
  setUnoTierFilter: (unoTierFilter) => set({ unoTierFilter }),
  setUnoCapabilityFilters: (unoCapabilityFilters) => set({ unoCapabilityFilters }),
  setUnoProviderFilter: (unoProviderFilter) => set({ unoProviderFilter }),
  setUnoSortMode: (unoSortMode) => set({ unoSortMode }),
}));

export function resetModelPickerFilterStoreForTests(): void {
  useModelPickerFilterStore.setState(DEFAULT_MODEL_PICKER_FILTER_STATE);
}
