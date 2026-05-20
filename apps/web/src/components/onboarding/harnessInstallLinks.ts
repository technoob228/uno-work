import { readLocalApi } from "~/localApi";

export const HARNESS_INSTALL_LINKS: Record<string, string> = {
  uno: "",
  codex: "https://github.com/openai/codex",
  claudeAgent: "https://docs.claude.com/en/docs/claude-code/overview",
  opencode: "https://opencode.ai",
  cursor: "https://docs.cursor.com/cli",
};

export function openInstallDocs(url: string): void {
  if (!url) return;
  const api = readLocalApi();
  if (api) {
    void api.shell.openExternal(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
