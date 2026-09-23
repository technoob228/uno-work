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
and a one-time download of about 300 MB per browser, which is then cached.

## Files

| File                                                                       | Role                                                                                                                        |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/office/officeFormats.ts`                          | Extension → editor, save target. `isOfficeFile()` is the hook for Files.                                                    |
| `apps/web/src/components/office/officeEngine.ts`                           | Loads `api.js`, mounts DocEditor, exports bytes by intercepting `AscCommon.DownloadFileFromBytes` inside the editor iframe. |
| `apps/web/src/components/office/normalizeXlsx.ts`                          | Workaround for the x2t `inlineStr` bug (below).                                                                             |
| `apps/web/src/components/office/officeSave.ts`                             | Chunked write-back.                                                                                                         |
| `apps/web/src/components/office/OfficeView.tsx`, `routes/_chat.office.tsx` | The screen.                                                                                                                 |
| `scripts/install-office-engine.sh`                                         | Installs the engine package.                                                                                                |

## Hooking into Files

```ts
import { isOfficeFile } from "~/components/office/officeFormats";
// in the file-opener registry:
if (isOfficeFile(path)) navigate({ to: "/office", search: { path } });
```

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

The page autosaves 3 s after an edit (plus Ctrl/Cmd+S and Save). Visitors type
a name once (localStorage) — it's the author of their comments.

**Comment links are enforced by the editor UI, not the server:** comments live
inside the document, so a comment save is a whole-file write. Someone who
crafts requests by hand with a comment link can change the text. Every save is
kept as a version, so it can be rolled back. (Same limit as the future co-edit
relay — see the research report of 2026-09-23.)

**Macros and plugins are off** in every mode. ONLYOFFICE macros are
JavaScript stored in the document and would run on the machine's origin —
the same origin as the owner's session — so a document edited through a link
could otherwise act as the owner.

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
7. **First open costs ~110 MB** of engine download per browser (measured in a
   fresh Chrome profile over localhost, sum of content-length), then cached for
   a day (`Cache-Control: max-age=86400`). A shared link's visitor pays it too.

## Licensing

The engine package is **AGPL-3.0** (ONLYOFFICE):

- It is served as we received it (an already-patched se-office build, see
  kludge 3) as a separate work under `/office-engine/`, next to its
  `LICENSE.txt`. Its source must stay available to users.
- The ONLYOFFICE logo and copyright must stay; white-labelling needs a
  commercial licence.
- If we modify the engine, we must publish the modified source to users.

Work's own code only talks to the engine through its public `DocsAPI` in the
browser.
