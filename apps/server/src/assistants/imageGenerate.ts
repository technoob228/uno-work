/**
 * `image_generate` (MCP `uno-work`): a picture from the Uno gateway
 * (`POST /v1/images/generations`, OpenAI-compatible), saved as a file in the
 * chat's folder and shown in the right panel. Works in every harness — it is
 * a tool of the daemon, not a model of the chat.
 *
 * The gateway key is the harness key (`unollm_…`), the same one chats use;
 * the account pays per picture by the one-wallet rules (the console decides,
 * a free chat key / trial computer gets 403 with a human sentence).
 *
 * @module assistants/imageGenerate
 */
import * as fsp from "node:fs/promises";
import * as nodePath from "node:path";

export const IMAGE_SIZES = ["1024x1024", "1024x1536", "1536x1024", "auto"] as const;
export const IMAGE_PROMPT_MAX_CHARS = 8_000;
/** Folder (inside the chat's folder) the pictures land in. */
export const IMAGES_FOLDER = "images";
const GATEWAY_TIMEOUT_MS = 180_000;

export interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly model: string | null;
  readonly costUsd: number | null;
}

export class ImageGenerateError extends Error {}

/** What the model reads when the gateway said no. */
export function imageGatewayProblem(status: number, body: unknown): string {
  const record =
    typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  const nested =
    record && typeof record.error === "object" && record.error !== null
      ? (record.error as Record<string, unknown>)
      : null;
  const said = [
    record?.detail,
    record?.message,
    nested?.message,
    typeof record?.error === "string" ? record.error : undefined,
  ].find((value): value is string => typeof value === "string" && value.length > 0);
  switch (status) {
    case 401:
      return "This computer has no working Uno AI key, so it can't make pictures. Tell the person.";
    case 402:
      return `Not enough balance for a picture${said ? ` (${said})` : ""}. Tell the person; don't retry.`;
    case 403:
      return `Pictures aren't available on this plan${said ? `: ${said}` : ""}. Tell the person; don't retry.`;
    case 404:
    case 405:
      return "Picture generation isn't switched on in the Uno gateway yet. Tell the person.";
    default:
      return `The Uno gateway couldn't make the picture (HTTP ${status}${said ? `: ${said}` : ""}).`;
  }
}

/** The first image of an OpenAI-style answer: `b64_json` or a data URL. */
export function decodeGeneratedImage(body: unknown): GeneratedImage | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const first = Array.isArray(record.data) ? (record.data[0] as Record<string, unknown>) : null;
  let base64: string | null = null;
  if (typeof first?.b64_json === "string" && first.b64_json.length > 0) {
    base64 = first.b64_json;
  } else if (typeof first?.url === "string") {
    const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(first.url);
    base64 = match?.[1] ?? null;
  }
  if (base64 === null) return null;
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (bytes.length === 0) return null;
  const usage = record.usage as { cost_usd?: unknown } | undefined;
  return {
    bytes,
    model: typeof record.model === "string" ? record.model : null,
    costUsd: typeof usage?.cost_usd === "number" ? usage.cost_usd : null,
  };
}

/** File extension from the picture's magic bytes (PNG by default). */
export function imageExtension(bytes: Uint8Array): "png" | "jpg" | "webp" | "gif" {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45
  ) {
    return "webp";
  }
  return "png";
}

const pad2 = (value: number) => String(value).padStart(2, "0");

/** A short, safe file stem from the prompt: `red-fox-logo-20261002-1530`. */
export function imageFileStem(prompt: string, now: Date): string {
  const words = prompt
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((word) => word.length > 0)
    .slice(0, 5)
    .join("-")
    .slice(0, 40);
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `${words || "image"}-${stamp}`;
}

export async function requestGatewayImage(input: {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly prompt: string;
  readonly size?: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): Promise<GeneratedImage> {
  if (input.apiKey.length === 0) throw new ImageGenerateError(imageGatewayProblem(401, null));
  const response = await (input.fetchImpl ?? globalThis.fetch)(
    `${input.baseUrl.replace(/\/+$/, "")}/images/generations`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "default",
        prompt: input.prompt,
        n: 1,
        ...(input.size && input.size !== "auto" ? { size: input.size } : {}),
      }),
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    },
  ).catch((cause: unknown) => {
    throw new ImageGenerateError(
      `The Uno gateway didn't answer (${cause instanceof Error ? cause.message : String(cause)}).`,
    );
  });
  const text = await response.text().catch(() => "");
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) throw new ImageGenerateError(imageGatewayProblem(response.status, body));
  const image = decodeGeneratedImage(body);
  if (image === null) {
    throw new ImageGenerateError("The Uno gateway answered without a picture. Try another prompt.");
  }
  return image;
}

/** Save next to the chat's work; never overwrites (a suffix is added). */
export async function saveGeneratedImage(input: {
  readonly folder: string;
  readonly prompt: string;
  readonly image: GeneratedImage;
  readonly now?: Date;
}): Promise<string> {
  const dir = nodePath.join(input.folder, IMAGES_FOLDER);
  await fsp.mkdir(dir, { recursive: true });
  const stem = imageFileStem(input.prompt, input.now ?? new Date());
  const ext = imageExtension(input.image.bytes);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const file = nodePath.join(dir, `${stem}${attempt === 0 ? "" : `-${attempt}`}.${ext}`);
    try {
      await fsp.writeFile(file, input.image.bytes, { flag: "wx" });
      return file;
    } catch (cause) {
      if ((cause as { code?: unknown }).code !== "EEXIST") throw cause;
    }
  }
  throw new ImageGenerateError("Could not pick a free file name for the picture.");
}
