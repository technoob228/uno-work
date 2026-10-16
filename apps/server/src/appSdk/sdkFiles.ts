/**
 * `~/.uno/sdk/` — the App SDK on every machine, written by the daemon at
 * start (docs/app-sdk.md): an agent building an app here imports it straight
 * from disk, nothing to download.
 *
 *   ~/.uno/sdk/js/uno-app.mjs  (+ uno-app.d.ts, package.json → `npm i ~/.uno/sdk/js`)
 *   ~/.uno/sdk/js/uno-chat.js  (the <uno-chat> web component; also next to uno_app.py)
 *   ~/.uno/sdk/python/uno_app.py
 *   ~/.uno/sdk/bin/uno         (the `uno` shell command → js/uno-cli.mjs; on agents' PATH)
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { APP_SDK_BUNDLE } from "./sdkBundle.generated.ts";
import { UNO_CLI_BIN_RELATIVE } from "./unoCliPath.ts";

/**
 * `~/.uno/sdk/bin/uno`: a launcher that is valid CommonJS and ESM alike (an
 * extensionless file's module type depends on the Node version), so the code
 * itself stays one ES module next to the SDK.
 */
export const UNO_CLI_LAUNCHER = `#!/usr/bin/env node
// \`uno\` — Uno Work from the shell (\`uno help\`). Code: ../js/uno-cli.mjs, kept by Uno Work.
import("../js/uno-cli.mjs").then((cli) => cli.run(process.argv.slice(2)));
`;

const UNO_CLI_BIN = `${UNO_CLI_BIN_RELATIVE}/uno`;

export const SDK_JS_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "@uno4/app",
    version: "0.1.0",
    type: "module",
    main: "./uno-app.mjs",
    types: "./uno-app.d.ts",
    exports: { ".": { types: "./uno-app.d.ts", default: "./uno-app.mjs" } },
  },
  null,
  2,
)}\n`;

export function sdkFiles(): ReadonlyArray<readonly [string, string]> {
  return [
    ["js/uno-app.mjs", APP_SDK_BUNDLE.jsModule],
    ["js/uno-app.d.ts", APP_SDK_BUNDLE.jsTypes],
    // TypeScript looks for `.d.mts` next to an `.mjs` imported by path.
    ["js/uno-app.d.mts", APP_SDK_BUNDLE.jsTypes],
    ["js/package.json", SDK_JS_PACKAGE_JSON],
    // <uno-chat>: served to the browser by an app's backend (chatHandler / chat_component_js).
    ["js/uno-chat.js", APP_SDK_BUNDLE.chatComponent],
    ["python/uno_app.py", APP_SDK_BUNDLE.python],
    ["python/uno-chat.js", APP_SDK_BUNDLE.chatComponent],
    ["js/uno-cli.mjs", APP_SDK_BUNDLE.cli],
    [UNO_CLI_BIN, UNO_CLI_LAUNCHER],
  ];
}

export async function installSdkFiles(home: string): Promise<void> {
  const root = path.join(home, ".uno", "sdk");
  for (const [relative, body] of sdkFiles()) {
    const file = path.join(root, relative);
    const executable = relative === UNO_CLI_BIN;
    const current = await readFile(file, "utf8").catch(() => null);
    if (current !== body) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body, { mode: executable ? 0o755 : 0o644 });
    }
    // `mode` applies only to a new file; an older copy may lack the exec bit.
    if (executable) await chmod(file, 0o755);
  }
}
