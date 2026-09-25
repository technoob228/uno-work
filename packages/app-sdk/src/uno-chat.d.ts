/** `<uno-chat>` — the drop-in chat web component (browser). See uno-chat.js. */
export interface UnoChatOptions {
  /** The app's own backend endpoint (default "/uno/chat"). */
  endpoint?: string;
  /** A first line shown before anything is asked. */
  greeting?: string;
  placeholder?: string;
  /** A title bar. */
  heading?: string;
  /** Extra headers for the app's endpoint (e.g. a CSRF token) — never the app token. */
  headers?: Record<string, string>;
}

export declare function escapeHtml(text: string): string;
/** Markdown-light → safe HTML (everything escaped; http(s) links only). */
export declare function renderMarkdown(text: string): string;
export declare function parseChatEvent(data: string): {
  delta?: string;
  error?: string;
  done?: boolean;
};

export declare class UnoChatElement extends HTMLElement {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  options: UnoChatOptions;
  send(text: string): Promise<void>;
  clear(): void;
}

export declare const UnoChat: {
  mount(el: Element, options?: UnoChatOptions): UnoChatElement;
};

export declare function define(): void;
