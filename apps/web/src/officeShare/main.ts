/**
 * The page behind a share link to a Word/Excel/PowerPoint file
 * (`/s/<token>`, rendered by the daemon from `office-share.html`).
 *
 * No login and no Work app here: the page reads its link config (injected by
 * the daemon as inert JSON), opens the file in the same in-browser engine the
 * owner uses, and — for "comment"/"edit" links — saves back through the link:
 *
 *   GET  <link>/.file   bytes + `x-uno-version`
 *   GET  <link>/.state  { version } — polled to notice changes on the computer
 *   POST <link>/.save   bytes, `x-uno-base-version` → 200 | 409 conflict
 *
 * Saving is automatic a few seconds after an edit (like Google Docs), plus
 * Ctrl/Cmd+S and the Save button. If the file changed on the computer since
 * it was opened, nothing is overwritten: the visitor gets a banner and
 * chooses to download their copy, replace, or reload.
 */
import { normalizeXlsxForEngine } from "../components/office/normalizeXlsx";
import {
  createOfficeEditor,
  type OfficeAccess,
  type OfficeEditorHandle,
} from "../components/office/officeEngine";
import "./officeShare.css";

interface ShareConfig {
  readonly name: string;
  readonly access: OfficeAccess;
  readonly documentType: "word" | "cell" | "slide";
  readonly extension: string;
  readonly fileUrl: string;
  readonly stateUrl: string;
  readonly saveUrl: string | null;
  readonly downloadUrl: string;
  readonly expiresAt: string | null;
}

const AUTOSAVE_DELAY_MS = 3_000;
const STATE_POLL_MS = 15_000;
const NAME_KEY = "uno-share:name";
const ID_KEY = "uno-share:id";

const ACCESS_LABEL: Record<OfficeAccess, string> = {
  view: "Anyone with the link can view",
  comment: "Anyone with the link can comment",
  edit: "Anyone with the link can edit",
};
const TYPE_ICON: Record<ShareConfig["documentType"], string> = {
  word: "W",
  cell: "X",
  slide: "P",
};

function readConfig(): ShareConfig | null {
  const node = document.getElementById("uno-share-config");
  if (!node?.textContent) return null;
  try {
    return JSON.parse(node.textContent) as ShareConfig;
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; attrs?: Record<string, string> } = {},
  children: Array<Node> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  for (const [key, value] of Object.entries(props.attrs ?? {})) node.setAttribute(key, value);
  for (const child of children) node.appendChild(child);
  return node;
}

function visitorIdentity(): { id: string; name: string } {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = `guest-${crypto.randomUUID().slice(0, 8)}`;
    localStorage.setItem(ID_KEY, id);
  }
  return { id, name: localStorage.getItem(NAME_KEY) ?? "" };
}

async function start(config: ShareConfig) {
  document.title = `${config.name} · Uno`;
  const root = document.getElementById("uno-share-root")!;

  // ── Chrome ──
  const status = el("span", { className: "us-status", attrs: { "data-testid": "share-status" } });
  const saveButton = el("button", {
    className: "us-btn us-btn-primary",
    text: "Save",
    attrs: { type: "button", "data-testid": "share-save" },
  });
  const download = el("a", {
    className: "us-btn",
    text: "Download",
    attrs: { href: config.downloadUrl, "data-testid": "share-download" },
  });
  const header = el("header", { className: "us-header" }, [
    el("span", {
      className: `us-icon us-icon-${config.documentType}`,
      text: TYPE_ICON[config.documentType],
    }),
    el("div", { className: "us-title" }, [
      el("div", { className: "us-name", text: config.name, attrs: { title: config.name } }),
      el("div", {
        className: "us-access",
        text: ACCESS_LABEL[config.access],
        attrs: { "data-testid": "share-access" },
      }),
    ]),
    status,
    ...(config.saveUrl ? [saveButton] : []),
    download,
  ]);
  const banner = el("div", { className: "us-banner", attrs: { hidden: "" } });
  const stage = el("div", { className: "us-stage" });
  const editorHost = el("div", {
    className: "us-editor",
    attrs: { "data-testid": "share-editor" },
  });
  const overlay = el("div", { className: "us-overlay" }, [
    el("div", { className: "us-spinner" }),
    el("p", { text: "Opening the document…" }),
    el("p", {
      className: "us-hint",
      text: "The first time takes up to a minute while the editor loads. After that it opens right away.",
    }),
  ]);
  stage.append(editorHost, overlay);
  root.append(header, banner, stage);

  const setStatus = (text: string) => {
    status.textContent = text;
  };
  const showBanner = (message: string, actions: Array<[string, () => void, boolean?]>) => {
    banner.replaceChildren(
      el("span", { text: message }),
      ...actions.map(([label, onClick, primary]) => {
        const button = el("button", {
          className: primary ? "us-btn us-btn-primary" : "us-btn",
          text: label,
          attrs: { type: "button" },
        });
        button.addEventListener("click", onClick);
        return button;
      }),
    );
    banner.hidden = false;
  };
  const hideBanner = () => {
    banner.hidden = true;
    banner.replaceChildren();
  };
  const fail = (message: string) => {
    overlay.replaceChildren(
      el("p", { className: "us-error", text: message }),
      el("p", { className: "us-hint", text: "You can still download the file." }),
    );
    overlay.hidden = false;
  };

  // ── Who is commenting/editing ──
  const identity = visitorIdentity();
  if (config.access !== "view" && !identity.name) {
    identity.name = await askName();
  }

  // ── Load ──
  const response = await fetch(config.fileUrl, { cache: "no-store" });
  if (!response.ok) {
    fail(
      response.status === 401
        ? "This link needs its password again. Reload the page."
        : "The document couldn't be loaded from the computer.",
    );
    return;
  }
  let baseVersion = response.headers.get("x-uno-version");
  let bytes: Uint8Array = new Uint8Array(await response.arrayBuffer());
  if (config.extension === "xlsx") bytes = await normalizeXlsxForEngine(bytes);

  let editor: OfficeEditorHandle | null = null;
  let dirty = false;
  let saving = false;
  let blocked = false; // a conflict is waiting for the visitor's choice
  let autosaveTimer: number | null = null;

  const scheduleAutosave = () => {
    if (!config.saveUrl || blocked) return;
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => void save(false), AUTOSAVE_DELAY_MS);
  };

  const save = async (force: boolean) => {
    if (!config.saveUrl || !editor || saving) return;
    if (blocked && !force) return;
    if (autosaveTimer !== null) window.clearTimeout(autosaveTimer);
    autosaveTimer = null;
    saving = true;
    setStatus("Saving…");
    try {
      const out = await editor.exportBytes(config.extension);
      const reply = await fetch(`${config.saveUrl}${force ? "?force=1" : ""}`, {
        method: "POST",
        body: out as BlobPart,
        headers: {
          "content-type": "application/octet-stream",
          ...(baseVersion ? { "x-uno-base-version": baseVersion } : {}),
        },
      });
      const body = (await reply.json().catch(() => ({}))) as { version?: string; error?: string };
      if (reply.status === 409) {
        blocked = true;
        setStatus("Not saved");
        showBanner(
          "Someone changed this file on the computer after you opened it. Your edits aren't saved yet — nothing was overwritten.",
          [
            ["Download my version", () => downloadBytes(out, config.name)],
            [
              "Replace with my version",
              () => {
                if (
                  window.confirm(
                    "Replace the file on the computer with your version? The other changes will be kept as an older version on the computer.",
                  )
                ) {
                  hideBanner();
                  blocked = false;
                  void save(true);
                }
              },
            ],
            [
              "Reload the latest",
              () => {
                if (window.confirm("Reload? Your unsaved edits will be lost.")) {
                  dirty = false;
                  location.reload();
                }
              },
              true,
            ],
          ],
        );
        return;
      }
      if (!reply.ok || !body.version) {
        setStatus("Not saved");
        showBanner(body.error ?? "Couldn't save to the computer. Try again in a moment.", [
          ["Try again", () => void save(force), true],
        ]);
        return;
      }
      baseVersion = body.version;
      blocked = false;
      hideBanner();
      dirty = false;
      editor.markSaved();
      setStatus(
        `Saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      );
    } catch (error) {
      setStatus("Not saved");
      showBanner(error instanceof Error ? error.message : "Couldn't save.", [
        ["Try again", () => void save(force), true],
      ]);
    } finally {
      saving = false;
      // Edits made while the save was running get their own save.
      if (dirty && !blocked && autosaveTimer === null) scheduleAutosave();
    }
  };
  saveButton.addEventListener("click", () => void save(false));

  try {
    editor = await createOfficeEditor({
      container: editorHost,
      bytes,
      fileName: config.name,
      fileType: config.extension,
      documentType: config.documentType,
      access: config.access,
      userId: identity.id,
      userName: identity.name || "Guest",
      onReady: () => {
        overlay.hidden = true;
        setStatus(config.access === "view" ? "View only" : "All changes saved");
      },
      onDirtyChange: (value) => {
        if (!value || !config.saveUrl) return;
        dirty = true;
        setStatus("Unsaved changes");
        scheduleAutosave();
      },
      onError: (message) => fail(`The editor couldn't open this document: ${message}`),
      onSaveRequest: () => void save(false),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "The editor couldn't start.");
    return;
  }

  window.addEventListener("beforeunload", (event) => {
    if (dirty) event.preventDefault();
  });

  // ── Notice changes made on the computer while this page is open ──
  window.setInterval(async () => {
    if (saving || blocked) return;
    const reply = await fetch(config.stateUrl, { cache: "no-store" }).catch(() => null);
    if (!reply?.ok) return;
    const state = (await reply.json().catch(() => null)) as { version?: string } | null;
    if (!state?.version || state.version === baseVersion) return;
    if (dirty) {
      void save(false); // → 409 → the conflict banner; nothing is overwritten
      return;
    }
    showBanner("A newer version of this file was saved on the computer.", [
      ["Reload", () => location.reload(), true],
    ]);
  }, STATE_POLL_MS);
}

function downloadBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const link = el("a", { attrs: { href: url, download: name } });
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function askName(): Promise<string> {
  return new Promise((resolve) => {
    const input = el("input", {
      className: "us-input",
      attrs: {
        type: "text",
        placeholder: "Your name",
        maxlength: "60",
        "data-testid": "share-name",
      },
    });
    const done = (name: string) => {
      const clean = name.trim().slice(0, 60);
      if (clean) localStorage.setItem(NAME_KEY, clean);
      dialog.remove();
      resolve(clean);
    };
    const go = el("button", {
      className: "us-btn us-btn-primary",
      text: "Continue",
      attrs: { type: "submit", "data-testid": "share-name-continue" },
    });
    const skip = el("button", { className: "us-btn", text: "Skip", attrs: { type: "button" } });
    skip.addEventListener("click", () => done(""));
    const form = el("form", { className: "us-card" }, [
      el("h2", { text: "What's your name?" }),
      el("p", { text: "It's shown next to your comments and edits." }),
      input,
      el("div", { className: "us-row" }, [skip, go]),
    ]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      done(input.value);
    });
    const dialog = el("div", { className: "us-modal" }, [form]);
    document.body.appendChild(dialog);
    input.focus();
  });
}

const config = readConfig();
if (config) {
  void start(config);
} else {
  document.getElementById("uno-share-root")!.textContent = "This link isn't available.";
}
