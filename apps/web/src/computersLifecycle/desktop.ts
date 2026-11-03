/**
 * Is this the desktop app (where "This computer" means the laptop itself)? In
 * the demo the "what to look at" panel can pretend so (`platform=desktop`).
 */
import { useDemoDesktop } from "../demo/demoFlag";
import { isElectron } from "../env";

export function useComputersLifecycleDesktop(): boolean {
  const demoDesktop = useDemoDesktop();
  return isElectron || demoDesktop;
}
