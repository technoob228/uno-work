/**
 * HermesAdapter — shape type for the Hermes provider adapter.
 *
 * Как и у Cursor: тег-сервиса нет, драйвер ({@link ../Drivers/HermesDriver})
 * захватывает по одному адаптеру на инстанс; интерфейс — именованный якорь
 * для бандла драйвера.
 *
 * @module HermesAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * HermesAdapterShape — per-instance Hermes adapter contract.
 */
export interface HermesAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
