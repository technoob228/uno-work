/**
 * Prints Comment's page script for the person's Uno Sites pages (19.10): the
 * console (fishcode) serves it as `/__uno/page-tools.js` on site hosts and
 * embeds it from `back/internal/api/site_page_tools.js` — that file is made
 * from this output by fishcode's `scripts/sync-site-page-tools.sh`. Run after
 * every change of packages/shared/src/pageToolsScript.ts:
 *
 *   bun scripts/print-site-page-tools.ts > …/fishcode/back/internal/api/site_page_tools.js
 */
import { buildSitePageToolsScript } from "@t3tools/shared/pageToolsScript";

process.stdout.write(`${buildSitePageToolsScript()}\n`);
