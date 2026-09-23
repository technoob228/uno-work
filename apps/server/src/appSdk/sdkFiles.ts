/**
 * `~/.uno/sdk/` — the App SDK on every machine, written by the daemon at
 * start (docs/app-sdk.md): an agent building an app here imports it straight
 * from disk, nothing to download.
 *
 *   ~/.uno/sdk/js/uno-app.mjs  (+ uno-app.d.ts, package.json → `npm i ~/.uno/sdk/js`)
 *   ~/.uno/sdk/python/uno_app.py
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { APP_SDK_BUNDLE } from "./sdkBundle.generated.ts";

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
    ["python/uno_app.py", APP_SDK_BUNDLE.python],
  ];
}

export async function installSdkFiles(home: string): Promise<void> {
  const root = path.join(home, ".uno", "sdk");
  for (const [relative, body] of sdkFiles()) {
    const file = path.join(root, relative);
    const current = await readFile(file, "utf8").catch(() => null);
    if (current === body) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body, { mode: 0o644 });
  }
}
