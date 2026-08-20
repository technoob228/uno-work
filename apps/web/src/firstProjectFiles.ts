/**
 * Чтение файлов из браузерного пикера (webkitdirectory) для загрузки в проект.
 * Вынесено из онбординга: тем же механизмом пользуется «Upload a folder» в
 * палитре команд при добавлении проекта.
 */

import type { FirstProjectFile } from "./firstProjectRunner";

export async function readFileAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function toFirstProjectFiles(fileList: FileList): FirstProjectFile[] {
  return Array.from(fileList).map((file) => ({
    rootRelativePath: file.webkitRelativePath || file.name,
    size: file.size,
    readBase64: () => readFileAsBase64(file),
  }));
}

/**
 * Открывает системный пикер каталога и отдаёт выбранные файлы. Должен
 * вызываться из обработчика пользовательского жеста, иначе браузер молча
 * проигнорирует click(). Отмена пикера не сообщается — колбэк просто не
 * будет вызван.
 */
export function pickFolderForUpload(onPicked: (files: FileList) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.setAttribute("webkitdirectory", "");
  input.style.display = "none";
  input.onchange = () => {
    const files = input.files;
    input.remove();
    if (files && files.length > 0) {
      onPicked(files);
    }
  };
  document.body.appendChild(input);
  input.click();
}
