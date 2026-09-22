import { bytesToBase64 } from "./officeBytes";

/** Как у загрузки файлов: 3 МБ бинарных → ~4 МБ base64 на одно WS-сообщение. */
export const OFFICE_SAVE_CHUNK_BYTES = 3 * 1024 * 1024;

export interface OfficeWriteFile {
  (input: {
    cwd: string;
    relativePath: string;
    contents: string;
    encoding: "base64";
    mode?: "append";
  }): Promise<unknown>;
}

/** Абсолютный путь файла → (каталог, имя) для projects.writeFile. */
export function splitWriteTarget(path: string): { cwd: string; relativePath: string } | null {
  const match = path.match(/^(.*)[\\/]([^\\/]+)$/);
  if (!match) return null;
  const [, parent, name] = match;
  if (!name) return null;
  return { cwd: parent === "" ? "/" : (parent ?? "/"), relativePath: name };
}

/**
 * Пишет байты документа обратно на машину. Первый кусок — replace, остальные —
 * append. КОСТЫЛЬ: запись не атомарна (у демона нет rename-RPC) — обрыв
 * связи посреди многокускового сохранения оставит обрезанный файл; для файлов
 * до 3 МБ (почти все docx/xlsx/pptx) это одно сообщение.
 */
export async function writeOfficeBytes(
  writeFile: OfficeWriteFile,
  path: string,
  bytes: Uint8Array,
  chunkBytes = OFFICE_SAVE_CHUNK_BYTES,
): Promise<void> {
  const target = splitWriteTarget(path);
  if (!target) throw new Error(`Некорректный путь: ${path}`);
  let offset = 0;
  do {
    const chunk = bytes.subarray(offset, offset + chunkBytes);
    await writeFile({
      cwd: target.cwd,
      relativePath: target.relativePath,
      contents: bytesToBase64(chunk),
      encoding: "base64",
      ...(offset === 0 ? {} : { mode: "append" as const }),
    });
    offset += chunk.length;
  } while (offset < bytes.length);
}
