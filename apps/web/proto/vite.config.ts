/**
 * A clickable prototype of the Home and My Uno variants, on mock data.
 *
 * Uses the real app's styles (`../src/index.css`) and UI kit
 * (`../src/components/ui/*`), so it looks like Uno Work, but has no daemon,
 * no account and no router — everything lives in one zustand store. Builds to
 * a single HTML file (`proto/dist/index.html`) that opens straight from disk.
 *
 *   bunx vite --config proto/vite.config.ts          # dev, :5790
 *   bunx vite build --config proto/vite.config.ts    # → proto/dist/index.html
 */
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const here = import.meta.dirname;

export default defineConfig({
  root: here,
  base: "./",
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: [
      // The app's utils pull in contracts and effect; the kit only needs cn().
      { find: /^~\/lib\/utils$/, replacement: path.resolve(here, "src/lib/utils.ts") },
      { find: /^~\//, replacement: `${path.resolve(here, "../src")}/` },
    ],
  },
  server: { port: 5790, strictPort: true },
  build: { outDir: path.resolve(here, "dist"), emptyOutDir: true },
});
