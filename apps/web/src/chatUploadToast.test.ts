import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_UPLOAD_TOAST_MIN_BYTES, stageChatFileWithToast } from "./chatUploadToast";
import { stageChatFileUpload } from "./chatUploads";
import { toastManager } from "./components/ui/toast";
import type { ComposerFileAttachment } from "./composerDraftStore";

vi.mock("./chatUploads", () => ({ stageChatFileUpload: vi.fn() }));
vi.mock("./components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn(() => "toast-1"), update: vi.fn(), close: vi.fn() },
}));

const attachment = (sizeBytes: number) =>
  ({ name: "film.mov", sizeBytes }) as ComposerFileAttachment;

describe("stageChatFileWithToast", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stays quiet for a small file", async () => {
    vi.mocked(stageChatFileUpload).mockResolvedValue({} as never);
    await stageChatFileWithToast("env" as never, attachment(10));
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("shows the upload of a big file and closes when it's done", async () => {
    vi.mocked(stageChatFileUpload).mockResolvedValue({} as never);
    await stageChatFileWithToast("env" as never, attachment(CHAT_UPLOAD_TOAST_MIN_BYTES));
    expect(toastManager.add).toHaveBeenCalledOnce();
    expect(toastManager.close).toHaveBeenCalledWith("toast-1");
  });

  it("closes and passes the failure on: the chat says why", async () => {
    const refusal = new Error("Not enough space on this computer");
    vi.mocked(stageChatFileUpload).mockRejectedValue(refusal);
    await expect(
      stageChatFileWithToast("env" as never, attachment(CHAT_UPLOAD_TOAST_MIN_BYTES)),
    ).rejects.toBe(refusal);
    expect(toastManager.close).toHaveBeenCalledWith("toast-1");
  });
});
