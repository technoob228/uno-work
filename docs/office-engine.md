# Office engine (docx / xlsx / pptx in the browser)

## What it is

`/office?path=<absolute path on the machine>` opens a Word, Excel or PowerPoint
file of the machine in a full editor and saves it back in place.

The editor is the ONLYOFFICE web editors (web-apps + sdkjs) packaged to run
**entirely in the browser**: the x2t format converter is compiled to
WebAssembly, so no ONLYOFFICE Document Server is needed. The daemon only:

- serves the static engine package from `<T3CODE_HOME>/office-engine` at
  `/office-engine/*` (`apps/server/src/officeEngine.ts`, route in `http.ts`);
- reads the file via `filesystem.readFile` (base64) and writes it via
  `projects.writeFile` (base64, chunked with `mode: "append"` above 3 MB).

The machine spends no RAM on the engine. The engine costs about 680 MB of disk
(+~28 MB of compressed copies, more as other files get requested; below). A browser downloads about 18 MB of it
compressed the first time (110 MB before 0.0.85) and then keeps it.

## Files

| File                                                                        | Role                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/office/officeFormats.ts`                           | Extension → editor, save target. `isOfficeFile()` is the hook for Files.                                                    |
| `apps/web/src/components/office/officeEngine.ts`                            | Loads `api.js`, mounts DocEditor, exports bytes by intercepting `AscCommon.DownloadFileFromBytes` inside the editor iframe. |
| `apps/web/src/components/office/normalizeXlsx.ts`                           | Workaround for the x2t `inlineStr` bug (below).                                                                             |
| `apps/web/src/components/office/officeSave.ts`                              | Chunked write-back.                                                                                                         |
| `apps/web/src/components/office/officeDocsShell.ts`, `OfficeDocsChrome.tsx` | Docs shell (Labs): our toolbar for Word on top of the engine (below).                                                       |
| `apps/web/src/components/office/OfficeView.tsx`, `routes/_chat.office.tsx`  | The screen.                                                                                                                 |
| `scripts/install-office-engine.sh`                                          | Installs the engine package.                                                                                                |

## Hooking into Files

```ts
import { isOfficeFile } from "~/components/office/officeFormats";
// in the file-opener registry:
if (isOfficeFile(path)) navigate({ to: "/office", search: { path } });
```

## Speed: how a document opens fast (0.0.85)

Measured on a 1-vCPU Work machine (box 2020 from image 169), Chrome in Buenos
Aires, ~240 ms to the machine, a 37 KB docx with tables (2026-09-25; scripts
and raw numbers in `tmp/office-speed/`). "docReady" = the document is drawn.

| Open                                                       | Before          | After                    |
| ---------------------------------------------------------- | --------------- | ------------------------ |
| First ever in this browser, straight to the document's URL | 21–37 s, 110 MB | 7.8 s, 18 MB             |
| First, from Files (engine warmed while the list was open)  | same            | 3.3 s                    |
| Again, same session                                        | 2.4–15.5 s      | 1.3–1.8 s                |
| Again, browser restarted                                   | 1.0–20 s        | 1.6 s                    |
| Reload / new tab (whole app + document)                    | 5.6–21 s        | 3.4–3.8 s                |
| First xlsx / pptx after a docx; again                      | —               | 3.8 / 6.2 s; 1.2 / 1.7 s |

"Before" swings so much because whether Chrome keeps the 61 MB x2t.wasm and
the 28 MB sdk-all.js in its HTTP cache depends on its cache size (small on a
Mac with little free disk): when it doesn't, every open downloads 90 MB again.

What changed:

- **Versioned engine URLs** — `/office-engine/v/<version>/…`, `version` = hash
  of the installed package's key files (`officeEngineAssets.ts`,
  `x-uno-office-engine-version` on every engine response). Cached for a year
  (`immutable`); a reinstall changes the version. A stale version is answered
  with the current file and `no-cache`. The old `/office-engine/…` still works
  (a day of cache, ETag/304).
- **Compressed copies** — brotli (q6) and gzip of each engine file, made once in
  `<engineDir>-compressed/<version>/` on the libuv thread pool: the critical
  files 20 s after the daemon starts (and after an install), the rest on their
  first request (gzip copies only on request — browsers send `br` over HTTPS).
  On the 1-vCPU box the critical brotli copies take ~5 s of CPU and ~28 MB of
  disk. 110 MB → 18 MB on the wire, and each entry is small enough for the
  HTTP cache. Other versions' copies are removed.
- **Service worker** — the package's worker is an inert stub; for versioned
  paths the daemon serves ours instead (`officeEngineServiceWorkerSource`):
  scope = that version's `vendor/`, cache-first from Cache Storage
  (`uno-office-engine-<version>`), navigations matched without the query.
  Cache Storage has no per-entry limit and isn't evicted with the HTTP cache.
- **Prewarm** (`officePrewarm.ts`) — registers the worker and fills its cache
  (two files at a time, low priority): when Files opens (Word + kinds used
  before), when Office opens (in parallel with reading the document), and
  15 s after the app starts, on idle, for browsers that opened Office before.
  Skipped on Save-Data/2G.
- **Parallel start** — api.js loads while the document is still being read.
- **Text preview** (`officePreviewModel.ts`, `OfficePreview.tsx`) — the
  document's words (headings, paragraphs, lists, tables; first sheet; slide
  text) show at once and give way to the editor on `onDocumentReady`.
- **The app's own files** (`staticCompression.ts`) — hashed `/assets/*` are
  now `immutable` and everything text is brotli/gzip (main bundle 5.2 → 1.4
  MB); before, every reload downloaded 5 MB uncompressed.

Not done, and why:

- **Opening docx without x2t** — sdkjs can open OOXML natively
  (`isOpenOOXInBrowser`), but only with the `ooxml` add-on, which this build
  doesn't have (`Asc.Addons.ooxml` unset, no `OpenDocumentFromZip`). Needs our
  own sdkjs build; x2t.wasm stays on the critical path of the first open.
- **The rest of a new tab's 3.4 s** is the app booting (auth, WebSocket,
  machine state) before Office starts — ~2.9 s at 240 ms RTT.

## Open in a new tab (0.0.85)

The Office header (and the Word File menu) has **Open in a new tab**:
`/office?path=…&tab=1` or `/office?bucket=…&key=…&tab=1` (+ `env=<id>` when the
file is on another computer than the page's own). Same origin, so it uses the
same Work session; signed out, the tab goes to `/pair?return=<that URL>` and
Sign in with Uno brings the person back to the document. The tab renders the
editor without the sidebar (`AppSidebarLayout`), saves the same way (autosave,
conflicts, versions) and its title is the file name.

The document _moves_: unsaved edits are saved first (the tab is opened before
the save, so pop-up blockers still see the click), then the original page goes
back to Files — one editor per document. If the save fails, the tab is closed
and the document stays where it was. Opening the same file in two tabs by
hand still gives two independent editors (Cloud: the second save gets the
conflict banner; computer files: last save wins) — no live co-editing yet.
A legacy .doc/.xls/.ppt saved as a new .docx/… opens the original in the tab.

## Share links: view / comment / edit (0.0.72)

A share link to a docx/xlsx/pptx (also odt/ods/odp) opens the document in the
same engine, in the visitor's browser, without an Uno account. The owner picks
the level when making the link, like Google Docs: **Can view** (default),
**Can comment**, **Can edit** (`file_shares.access`, migration 047). Old
doc/xls/ppt can only be shared to view — saving them would create a new file.

`/s/<token>` for an office file serves `office-share.html` with the link's
config injected as inert JSON (`?card=1` still gives the old download card).
The page talks only to its own link:

| Endpoint             | What                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `GET  <link>/.file`  | Bytes + `x-uno-version` (sha256 prefix of those bytes).                                       |
| `GET  <link>/.state` | `{version, modifiedAt}` — polled every 15 s to notice changes made on the computer.           |
| `POST <link>/.save`  | Body = bytes, header `x-uno-base-version`. 200 `{version}`, 409 conflict, 403 on a view link. |

Guarantees (tests in `files/http.test.ts`):

- the path always comes from the share row, never the request — a token
  reads and writes exactly its own file; dot-names (`.file`, `.save`) can't be
  real segments, so they never collide with files; folder links don't have them;
- a password link's editor calls need the unlocked cookie;
- saves are refused unless the body is a zip (OOXML/ODF), ≤ 60 MB;
- **no silent overwrite:** if the file changed on the computer since it was
  opened, the save is a 409 and the visitor chooses _Download my version_,
  _Replace with my version_ (`?force=1`, after a confirm) or _Reload_;
- one writer per file at a time; the previous bytes are kept in
  `<baseDir>/share-versions/<shareId>/` (last 20), then temp file + rename.

Office → **Versions** on a file of the computer lists these copies (from
every link that ever pointed at the file) and downloads them through
`GET /api/files/office-versions?path=…[&version=<id>]` (owner session; a
version id is only accepted for a link of that same file).

The page autosaves 3 s after an edit (plus Ctrl/Cmd+S and Save). Visitors type
a name once (localStorage) — it's the author of their comments.

**Comment links are enforced on the computer (0.0.78).** The editor saves a
whole docx, and the in-browser engine rewrites the entire package on every
save (a 1 MB styles part, split runs, dropped parts) even when only a comment
was added — so no diff against a file made by Word can tell "only comments"
from "also edits". The daemon therefore never writes the visitor's file for a
comment link (`files/docxComments.ts`):

1. the upload's body text must equal the current file's — characters, tabs,
   breaks, paragraph ends, one mark per picture/object — or the save is a
   `403 {code: "comment_only"}` and the page shows "This link can only
   comment" with _Download my version_ / _Reload the latest_;
2. the upload's comment markers are placed into the **current** file at the
   same text positions (a run is split where a comment starts mid-word);
3. the comment parts (comments, commentsExtended, commentsIds,
   commentsExtensible, people) are rebuilt from the upload as plain text with
   whitelisted attributes and wired in with fresh relationships/content types.

Everything else — formatting, pictures, styles, headers, macros, any extra
part in the upload — is the current file's. Tests use real engine exports
(`files/fixtures/comment-*.docx`, recorded 2026-09-23 with oo13); the check
was also run on six Word-made documents (round trip + two comments), and
LibreOffice and the engine both read the merged comments back.

Limits: **Word only** — comment links can't be made for xlsx/pptx/odt (the
share dialog hides the option; such links made before 0.0.78 open read-only
with a note). A document whose headers/footers/notes already carry comments
refuses comment saves ("ask for an edit link"). A comment's author name is
whatever the visitor typed. Deleting a comment can leave the run split where
it was anchored (invisible).

**Macros and plugins are off** in every mode. ONLYOFFICE macros are
JavaScript stored in the document and would run on the machine's origin —
the same origin as the owner's session — so a document edited through a link
could otherwise act as the owner.

## Documents in Cloud storage (0.0.78)

`/office?bucket=<id>&key=<key>` opens a docx/xlsx/pptx straight from the
account's Cloud storage (Files → Cloud storage → click the document, or
"Open in Office" in its menu) and saves it back there
(`files/cloudOffice.ts`, RPCs `files.cloud.officeOpen` / `officeSave`):

- the daemon downloads the object (presigned GET — S3 keys stay in the
  console) into `~/.uno-office-cloud/<random>/`, the page reads it and
  deletes it; a save goes the same way in reverse. Leftovers older than an
  hour are swept on the next open. The disk only holds a document while it
  is being moved;
- the version is the sha256 prefix of the bytes. On save the daemon downloads
  the current object again: if someone saved in between (another computer, an
  upload in Files) — or deleted it — nothing is overwritten and Office shows
  the same choice as a share link: _Download my version_ / _Replace with my
  version_ / _Reload the latest_;
- the previous content is kept as `<folder>/.versions/<name>/<time>.<ext>`,
  the last **10** (they count toward the Cloud quota). Files doesn't show
  `.versions` folders; Office → **Versions** lists the copies (time, size)
  with a download for each (RPC `files.cloud.officeVersions`, presigned link);
- doc/xls/ppt open read-only from the cloud (saving would change the format).

**Share links to Cloud documents: not yet** — links serve files of the
computer. The Cloud menu says so ("Share link — not yet for Cloud"); copy the
document to this computer to share it.

## Docs shell: our own toolbar for Word (0.0.78 in Labs; on by default since 0.0.82)

Settings → Labs → **Simple toolbar for Word documents** (`officeDocsShell`)
opens docx/doc/odt/rtf with a Google-Docs-like title bar and one toolbar
instead of the engine's ribbon. Spreadsheets and presentations are untouched.
Since 0.0.82 it is on for everyone who never touched the toggle; an explicit
"off" in Labs is stored in the sparse `featureFlags` map and still wins.

How (`officeDocsShell.ts`, `OfficeDocsChrome.tsx`):

- a stylesheet injected into the editor iframe hides `#toolbar`, `#statusbar`,
  `#left-menu`, `#right-menu`; the engine's layout skips hidden panels, so the
  page takes the room. Rulers are switched off with `asc_SetViewRulers(false)`
  (session only). The engine package itself is not modified;
- buttons call the same editor API the ribbon calls (`put_TextPrBold`,
  `put_Style`, `put_ListTypeCustom`…); the buttons follow the cursor through
  the engine's callbacks (`asc_onBold`, `asc_onParaStyleName`…);
- anything with a dialog goes to the engine's own controllers, so its dialogs
  open unchanged: link (`Links.onHyperlinkClick`), table, image by URL,
  comment, find (`search:show`), find & replace (shows the left bar), print;
- ⋯ → **Show full toolbar** brings the ribbon back for everything else;
- the document autosaves 3 s after the last edit (not for legacy .doc, which
  would become a new .docx each time); File → Download .docx/.pdf/.odt goes
  through the same export queue as saving; the name renames the file; Share
  opens the Files share dialog; File → Versions opens the Versions dialog.
- Cloud documents work in the shell too: the same save (conflict banner,
  versions), the "Cloud storage" badge, no rename/Share (not for Cloud yet).
  They autosave after **30 s** without edits, not 3 s — each cloud save keeps
  a copy in `.versions` (last 10), so 3 s would flush the useful ones out.
- a failed autosave waits for the next edit (no retry loop); a conflict waits
  for the person's choice.

Kludges: the shell reaches into engine internals (`window.DE` controllers,
`Asc.editor` methods, DOM ids) — an engine upgrade can break it; the unit tests
pin the calls we make, not the engine. List info must be built with the
iframe's own `JSON` (an object from the parent page is silently ignored).
The ONLYOFFICE logo stays in the title bar (AGPL-3.0 §7(b)).

## Known workarounds (kludges)

1. **x2t `inlineStr` bug.** In xlsx files that use `t="inlineStr"` (openpyxl,
   pandas and most generators — i.e. anything an agent writes), the engine
   drops every string cell that directly follows another inline string. For
   example, `1 | a | b` opens as `1 | a | (empty)`. Files from Excel or
   LibreOffice, which use sharedStrings, are not affected.
   - `normalizeXlsxForEngine` rewrites the simple inline strings to `t="str"`
     before opening. Verified on 2026-09-22.
2. **Save is not atomic.** There is no rename RPC, so a dropped connection in
   the middle of a save of more than 3 MB leaves a truncated file.
3. **The engine is a re-hosted third-party build** (`sweetwisdom/onlyoffice-web-local`,
   release-13, which is Qihoo360's se-office: web-apps and sdkjs are
   **patched** for offline use — `window.isOffline = true` in sdk-all-min.js,
   a replaced `loadDocument` in web-apps. We ship it as we got it, but it is
   not an unmodified ONLYOFFICE build). Since 0.0.70 it is served from
   `https://console.uno4.dev/cli/work/office-engine/` with pinned sha256
   (`office-engine-oo13.zip` 710153df…, `office-engine-oo13.tar.gz` 5269aa46…),
   baked into the Work golden image, and installable with the "Install Office"
   button (`POST /api/office-engine/install`, officeEngineInstall.ts). Building
   our own package from ONLYOFFICE sources is still open.
4. **Legacy formats save beside the original.** doc/xls/ppt are saved as a
   new .docx/.xlsx/.pptx next to the original.
5. **No slide theme gallery.** The package has only `sdkjs/slide/themes/src/*.pptx`;
   the generated `themes.js` (Document Server makes it at install) is missing,
   so Design → themes shows only the deck's own theme. The editor asks for
   `slide/themes//themes.js`; the daemon used to answer 400 for the `//`, now it
   collapses empty segments (404, harmless). Fix = generate `themes.js` when we
   build our own engine package.
6. **"Presentations don't work" on 395 (2026-09-23)** was a Markdown file
   named `test.pptx`: Files had no "New presentation", so it was made with
   "New document" and renamed. Now Files → New has Word document /
   Spreadsheet / Presentation (real blank files, chosen by the typed
   extension), and Office shows "This isn't a real presentation" with
   _Make it a blank presentation_ instead of spinning forever.
7. **First open costs ~18 MB** of engine download per browser since 0.0.85
   (110 MB before; see "Speed"). A shared link's visitor pays it too.
8. **x2t posts exported files to the top window.** The package's
   `x2t_helper.js` `downloadFile` posts the bytes to `window.parent` and
   `window.top` with target `*` on every "Download as". Our save path
   intercepts before it (no post), the editor menu's own download does not.
   Harmless while Work is the top window; fix in our own engine build.

## Licensing

The engine package is **AGPL-3.0** (ONLYOFFICE):

- It is served as we received it (an already-patched se-office build, see
  kludge 3) as a separate work under `/office-engine/`, next to its
  `LICENSE.txt`. Its source must stay available to users.
- The ONLYOFFICE logo and copyright must stay; white-labelling needs a
  commercial licence.
- If we modify the engine, we must publish the modified source to users.

Work doesn't only use the public `DocsAPI`: it patches the editor at runtime
(save interception, the Docs shell, the co-editing prototype) and, since 0.0.85,
replaces the package's service worker. All of it is published at
<https://github.com/technoob228/onlyoffice-uno-patches> (local draft:
`~/uno-project/onlyoffice-uno-patches/`, to be pushed by the coordinator).
The app links there from Office (File menu in Word, "ONLYOFFICE · AGPL" in the
header of the other editors) and from Settings → General → About.
