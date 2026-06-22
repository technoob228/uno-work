/**
 * Re-export of the shared CLI version helpers from `@t3tools/contracts`.
 *
 * The implementation moved to contracts so the desktop installer can reuse the
 * exact same comparison/extraction logic (see
 * `packages/contracts/src/cliVersion.ts`). This thin shim keeps existing
 * server-side imports (`./cliVersion.ts`) working unchanged.
 */
export {
  UNO_CODE_MINIMUM_VERSION,
  compareCliVersions,
  extractNumericCliVersion,
  normalizeCliVersion,
} from "@t3tools/contracts";
