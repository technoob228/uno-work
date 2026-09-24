/**
 * The web lite build flag, alone in a module without imports so the account
 * transport (and anything else low in the graph) can read it without cycles.
 * See ./webLite.ts for what lite is.
 */
export const isWebLite: boolean = import.meta.env.VITE_UNO_WORK_LITE === "1";
