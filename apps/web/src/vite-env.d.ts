/// <reference types="vite/client" />

import type { DesktopBridge, LocalApi } from "@t3tools/contracts";

interface ImportMetaEnv {
  readonly VITE_HTTP_URL: string;
  readonly VITE_WS_URL: string;
  readonly VITE_HOSTED_APP_URL: string;
  readonly APP_VERSION: string;
  /** "1" in the web lite build (apps/web/src/lite). */
  readonly VITE_UNO_WORK_LITE?: string;
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
