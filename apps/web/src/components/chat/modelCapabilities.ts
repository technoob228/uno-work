import type { ModelCapabilities } from "@t3tools/contracts";

export type ModelCapabilityFilter = "tools" | "image-input" | "image-output" | "streaming";

function modelHasModality(
  values: ReadonlyArray<string> | undefined,
  expectedModality: "image",
): boolean {
  return values?.some((modality) => modality.toLowerCase() === expectedModality) === true;
}

export function modelSupportsImageInput(
  capabilities: ModelCapabilities | null | undefined,
): boolean {
  const metadata = capabilities?.metadata;
  return (
    metadata?.supports?.attachments === true ||
    metadata?.supports?.vision === true ||
    modelHasModality(metadata?.modalities?.input, "image")
  );
}

export function modelSupportsImageOutput(
  capabilities: ModelCapabilities | null | undefined,
): boolean {
  return modelHasModality(capabilities?.metadata?.modalities?.output, "image");
}

export function modelSupportsTools(capabilities: ModelCapabilities | null | undefined): boolean {
  return capabilities?.metadata?.supports?.tools === true;
}

export function modelCannotRunCodingAgent(
  capabilities: ModelCapabilities | null | undefined,
): boolean {
  const metadata = capabilities?.metadata;
  if (!metadata) return false;
  if (modelSupportsImageOutput(capabilities)) return false;
  if (metadata.supports?.tools === false) return true;
  return false;
}

export function modelMatchesCapabilityFilter(
  capabilities: ModelCapabilities | null | undefined,
  capability: ModelCapabilityFilter,
): boolean {
  const metadata = capabilities?.metadata;
  if (capability === "tools") return modelSupportsTools(capabilities);
  if (capability === "image-input") return modelSupportsImageInput(capabilities);
  if (capability === "image-output") return modelSupportsImageOutput(capabilities);
  return metadata?.supports?.streaming === true;
}
