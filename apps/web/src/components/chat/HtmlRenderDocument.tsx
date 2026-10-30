/**
 * The agent's page in its frame. The frame is `srcdoc`, sandboxed, in an
 * opaque origin, with a policy of its own (`htmlRenderFrameDocument`): the page
 * can't reach the app's session, storage or DOM, and no network but public
 * libraries. All it can do is ask, by message, for a height, a link or a
 * picture. Those messages may be forged by the page's script, so a link and a
 * picture need the frame focused and a recent gesture, and a key only counts
 * for commands that change what the reader sees.
 */
import type { KeybindingCommand, KeybindingShortcut } from "@t3tools/contracts";
import {
  type HtmlRenderShortcut,
  htmlRenderFrameDocument,
  htmlRenderResult,
  htmlRenderShortcutsMessage,
  htmlRenderThemeMessage,
  HTML_RENDER_SANDBOX,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  withHtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { useHtmlRenderTheme } from "../../hooks/useHtmlRenderTheme";
import { chatLinkTarget, openUntrustedLinkExternally } from "../../lib/externalLinks";
import { useServerKeybindings } from "../../rpc/serverState";
import { cn, isMacPlatform } from "../../lib/utils";
import { usePreviewPane } from "../preview/PreviewPaneContext";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

/**
 * The page reports the keys, and a page script can report any key it likes,
 * so only commands that change what the reader sees are here, never one that
 * changes a thread.
 */
const PAGE_SHORTCUT_COMMANDS: ReadonlySet<KeybindingCommand> = new Set<KeybindingCommand>([
  "commandPalette.toggle",
  "sidebar.toggle",
  "rightPanel.toggle",
  "terminal.toggle",
  "navigation.back",
  "navigation.forward",
  "thread.previous",
  "thread.next",
]);

const pageShortcut = (shortcut: KeybindingShortcut, mac: boolean): HtmlRenderShortcut => ({
  key: shortcut.key,
  metaKey: shortcut.metaKey || (shortcut.modKey && mac),
  ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
  shiftKey: shortcut.shiftKey,
  altKey: shortcut.altKey,
});

const sameShortcut = (
  left: HtmlRenderShortcut,
  right: Pick<HtmlRenderShortcut, "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { key: string },
) =>
  left.key === right.key.toLowerCase() &&
  left.metaKey === right.metaKey &&
  left.ctrlKey === right.ctrlKey &&
  left.shiftKey === right.shiftKey &&
  left.altKey === right.altKey;

export function HtmlRenderDocument(props: {
  /** The stored page; read once, a new theme reaches a live page as a message. */
  readonly html: string;
  readonly title: string;
  readonly className?: string;
  readonly onContentHeight?: (height: number) => void;
}) {
  const theme = useHtmlRenderTheme();
  const { openUrl } = usePreviewPane();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [srcDoc] = useState(() => htmlRenderFrameDocument(withHtmlRenderTheme(props.html, theme)));
  const [loaded, setLoaded] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);

  const post = useCallback((message: unknown) => {
    frameRef.current?.contentWindow?.postMessage(message, "*");
  }, []);
  const postTheme = useEffectEvent(() => post(htmlRenderThemeMessage(theme)));
  useEffect(() => {
    postTheme();
  }, [theme]);

  const keybindings = useServerKeybindings();
  const { shortcuts, blocked } = useMemo(() => {
    const mac = isMacPlatform(navigator.platform);
    const allowed: HtmlRenderShortcut[] = [];
    const others: HtmlRenderShortcut[] = [];
    for (const { command, shortcut } of keybindings) {
      if (
        PAGE_SHORTCUT_COMMANDS.has(command) &&
        (shortcut.metaKey || shortcut.ctrlKey || shortcut.modKey)
      ) {
        allowed.push(pageShortcut(shortcut, mac));
      } else {
        others.push(pageShortcut(shortcut, mac));
      }
    }
    return { shortcuts: allowed, blocked: others };
  }, [keybindings]);
  const postShortcuts = useEffectEvent(() => post(htmlRenderShortcutsMessage(shortcuts, blocked)));
  useEffect(() => {
    postShortcuts();
  }, [shortcuts, blocked]);

  const onFrameMessage = useEffectEvent((frame: HTMLIFrameElement, event: MessageEvent) => {
    const height = readHtmlRenderContentHeight(event.data);
    if (height !== undefined) {
      props.onContentHeight?.(height);
      return;
    }
    // A page can take focus by script; this stops opens on load, though not a
    // page that waits for the reader's next input.
    if (document.activeElement !== frame || navigator.userActivation?.isActive === false) return;
    const link = readHtmlRenderLinkRequest(event.data);
    if (link !== undefined) {
      if (chatLinkTarget(link.url) === "own") openUrl(link.url);
      else openUntrustedLinkExternally(link.url);
      post(htmlRenderResult(link.id));
      return;
    }
    const key = readHtmlRenderKeyDown(event.data);
    if (key !== undefined) {
      if (shortcuts.some((shortcut) => sameShortcut(shortcut, key))) {
        frame.dispatchEvent(
          new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }),
        );
      }
      return;
    }
    const image = readHtmlRenderImageRequest(event.data);
    if (image !== undefined) {
      setExpandedImage({ images: [{ src: image.src, name: image.name }], index: 0 });
    }
  });

  // At commit: a fast page may post its first height before passive effects run.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source === frame.contentWindow) onFrameMessage(frame, event);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <>
      <iframe
        ref={frameRef}
        srcDoc={srcDoc}
        title={props.title}
        // Never allow-same-origin: the opaque origin keeps the page out of the app.
        sandbox={HTML_RENDER_SANDBOX}
        referrerPolicy="no-referrer"
        onLoad={() => {
          setLoaded(true);
          // Covers a theme change that landed while the page was loading.
          postTheme();
          postShortcuts();
        }}
        // Match the blank document's scheme to avoid a white flash, then follow the app.
        className={cn("border-0 bg-transparent", props.className)}
        style={{ colorScheme: loaded ? theme.appearance : "normal" }}
        data-testid="html-render-frame"
      />
      {expandedImage !== null
        ? createPortal(
            <ExpandedImageDialog preview={expandedImage} onClose={() => setExpandedImage(null)} />,
            document.body,
          )
        : null}
    </>
  );
}
