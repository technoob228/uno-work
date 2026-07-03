#!/usr/bin/env node
/**
 * Sync the Hermes sidecar with this Uno Work environment:
 *  - LLM key: reads `providers.uno.apiKey` from the environment's
 *    settings.json (the same Uno Gateway key the app uses) and writes it
 *    into ~/.hermes/config.yaml as the custom-endpoint api_key.
 *  - MCP wiring: copies the current manager MCP url + assistant token from
 *    the assistant workspace .mcp.json (survives daemon port drift).
 *
 * Usage: node scripts/hermes-sync.mjs [--home ~/.t3-manager-dev]
 * Idempotent; run any time settings or the daemon port change. Once a
 * native HermesDriver lands, the driver injects all of this itself and this
 * script retires.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const homeArgIndex = process.argv.indexOf("--home");
const t3Home =
  homeArgIndex !== -1
    ? process.argv[homeArgIndex + 1].replace(/^~/, homedir())
    : join(homedir(), ".t3");

function findStateDir() {
  for (const candidate of ["dev", "userdata"]) {
    const dir = join(t3Home, candidate);
    if (existsSync(join(dir, "state.sqlite"))) return dir;
  }
  throw new Error(`No environment state under ${t3Home} (looked in dev/ and userdata/).`);
}

const stateDir = findStateDir();

// 1. Uno Gateway key from app settings.
let unoApiKey = "";
const settingsPath = join(stateDir, "settings.json");
if (existsSync(settingsPath)) {
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  // Top-level `uno.apiKey` is the app's Uno Gateway key (Settings → Uno);
  // provider-level keys are legacy fallbacks.
  unoApiKey =
    settings?.uno?.apiKey?.trim() ||
    settings?.providers?.uno?.apiKey?.trim() ||
    settings?.providerInstances?.uno?.config?.apiKey?.trim() ||
    "";
}

// 2. Manager MCP wiring from the assistant workspace.
const mcpPath = join(stateDir, "assistant-workspace", ".mcp.json");
const mcp = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers["uno-manager"];

// 3. Rewrite ~/.hermes/config.yaml (managed block style: full rewrite of the
//    keys we own, comments preserved only at the top).
const hermesConfigPath = join(homedir(), ".hermes", "config.yaml");
const config = `# Managed by uno-work-app scripts/hermes-sync.mjs — re-run it after
# changing the Uno API key in app settings or restarting the environment.
model:
  provider: openrouter
  base_url: https://api.getuno.xyz/v1
  name: claude-sonnet-4-6
${unoApiKey ? `  api_key: ${unoApiKey}` : "  # api_key: <empty — set Uno API key in app Settings → Providers → Uno, then re-run>"}

mcp_servers:
  uno-manager:
    url: ${mcp.url}
    headers:
      Authorization: ${mcp.headers.Authorization}
`;
writeFileSync(hermesConfigPath, config);

console.log(`state dir:   ${stateDir}`);
console.log(`mcp url:     ${mcp.url}`);
console.log(`uno api key: ${unoApiKey ? "synced ✓" : "NOT SET — add it in Settings → Providers → Uno and re-run"}`);
