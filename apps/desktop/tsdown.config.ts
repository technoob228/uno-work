import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: (id) => id.startsWith("@t3tools/") || id.startsWith("effect-acp"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
    // Sandboxed: only `electron` at run time; contracts' constants are bundled in.
    noExternal: (id) => id.startsWith("@t3tools/"),
  },
  {
    // The panel browser's page preload (sandboxed: only `electron` at run
    // time), so the contracts' wire file is bundled in.
    ...shared,
    entry: ["src/pagePreload.ts"],
    noExternal: (id) => id.startsWith("@t3tools/"),
  },
]);
