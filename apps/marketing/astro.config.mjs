import { defineConfig } from "astro/config";

export default defineConfig({
  trailingSlash: "always",
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
});
