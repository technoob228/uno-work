/// <reference types="vite/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly APP_VERSION: string;
  /** "1" in the web lite build (apps/web/src/lite). */
  readonly VITE_UNO_WORK_LITE?: string;
  /** "1" on a local stand: assistants run against an in-memory account (lib/assistantsDemo.ts). */
  readonly VITE_ASSISTANTS_DEMO?: string;
  /** "heavy": a static demo build (icp3 09.10) — fixtures in the page, no daemon (src/demo). */
  readonly VITE_DEMO?: string;
  /** "stage": a bundle for the stage channel — its Labs flags on by default (unoChannel.ts). */
  readonly VITE_UNO_CHANNEL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare global {
  interface Window {
    nativeApi?: LocalApi;
    desktopBridge?: DesktopBridge;
  }
}
