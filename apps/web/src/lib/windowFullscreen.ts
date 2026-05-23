const FULLSCREEN_CLASS_NAME = "is-fullscreen";

export function syncDocumentFullscreenClass(): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const bridge = window.desktopBridge;
  if (!bridge) {
    return () => {};
  }

  const apply = (isFullscreen: boolean) => {
    document.documentElement.classList.toggle(FULLSCREEN_CLASS_NAME, isFullscreen);
  };

  apply(bridge.getWindowFullscreenState());
  return bridge.onWindowFullscreenChange(apply);
}
