import { HARNESS_OPTIONS } from "./telegramPageLogic";

/**
 * Harness + model pair as edited in the assistant settings. The harness is a
 * fixed list; the model is free text because every harness names models
 * differently and the authorized set lives on the daemon.
 */
export function ModelSelectionFields({
  instanceId,
  model,
  onInstanceChange,
  onModelChange,
  placeholder,
  disabled = false,
  ariaLabel,
}: {
  instanceId: string;
  model: string;
  onInstanceChange: (instanceId: string) => void;
  onModelChange: (model: string) => void;
  placeholder: string;
  disabled?: boolean;
  ariaLabel: string;
}) {
  return (
    <span className="flex gap-2">
      <select
        value={instanceId}
        disabled={disabled}
        aria-label={`${ariaLabel} harness`}
        onChange={(event) => onInstanceChange(event.target.value)}
        className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs"
      >
        {HARNESS_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={model}
        disabled={disabled}
        aria-label={`${ariaLabel} model`}
        onChange={(event) => onModelChange(event.target.value)}
        placeholder={placeholder}
        className="w-44 rounded-lg border border-border bg-background px-3 py-1.5 text-xs"
      />
    </span>
  );
}
