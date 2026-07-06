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
# Verified invocation (env wins over config in Hermes):
#   OPENAI_API_KEY=<uno key> OPENAI_BASE_URL=https://api.getuno.xyz/v1 \\
#     hermes --provider openai-api -m anthropic/claude-haiku-4.5 ...
model:
  provider: openai-api
  base_url: https://api.getuno.xyz/v1
  name: anthropic/claude-haiku-4.5
${unoApiKey ? `  api_key: ${unoApiKey}` : "  # api_key: <empty — set Uno API key in app Settings → Uno, then re-run>"}

providers:
  openai-api:
    request_timeout_seconds: 180
    stale_timeout_seconds: 120

${
  unoApiKey
    ? `stt:
  enabled: true
  provider: openai
  openai:
    model: openai/whisper-large-v3
    base_url: https://api.getuno.xyz/v1
    api_key: ${unoApiKey}
`
    : "# stt: <disabled — set Uno API key in app Settings → Uno, then re-run>\n"
}
mcp_servers:
  uno-manager:
    url: ${mcp.url}
    headers:
      Authorization: ${mcp.headers.Authorization}
`;
writeFileSync(hermesConfigPath, config);

// Hermes only reads the openai-api key from the environment, so ship a tiny
// wrapper: `~/.hermes/uno-hermes <hermes args…>`.
const wrapperPath = join(homedir(), ".hermes", "uno-hermes");
writeFileSync(
  wrapperPath,
  `#!/bin/sh
# Managed by uno-work-app scripts/hermes-sync.mjs
export OPENAI_API_KEY=${unoApiKey || "SET_UNO_KEY_IN_APP_SETTINGS"}
export OPENAI_BASE_URL=https://api.getuno.xyz/v1
export STT_OPENAI_BASE_URL=https://api.getuno.xyz/v1
export HERMES_INFERENCE_MODEL=\${HERMES_INFERENCE_MODEL:-anthropic/claude-haiku-4.5}
exec hermes --provider openai-api -m "\$HERMES_INFERENCE_MODEL" "$@"
`,
  { mode: 0o700 },
);

console.log(`state dir:   ${stateDir}`);
console.log(`mcp url:     ${mcp.url}`);
console.log(`uno api key: ${unoApiKey ? "synced ✓" : "NOT SET — add it in Settings → Uno and re-run"}`);
console.log(`wrapper:     ${wrapperPath} (use it instead of plain \`hermes\`)`);
