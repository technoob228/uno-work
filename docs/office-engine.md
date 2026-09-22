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

| File | Role |
|---|---|
| `apps/web/src/components/office/officeFormats.ts` | Extension → editor, save target. `isOfficeFile()` is the hook for Files. |
| `apps/web/src/components/office/officeEngine.ts` | Loads `api.js`, mounts DocEditor, exports bytes by intercepting `AscCommon.DownloadFileFromBytes` inside the editor iframe. |
| `apps/web/src/components/office/normalizeXlsx.ts` | Workaround for the x2t `inlineStr` bug (below). |
| `apps/web/src/components/office/officeSave.ts` | Chunked write-back. |
| `apps/web/src/components/office/OfficeView.tsx`, `routes/_chat.office.tsx` | The screen. |
| `scripts/install-office-engine.sh` | Installs the engine package. |

## Hooking into Files

```ts
import { isOfficeFile } from "~/components/office/officeFormats";
// in the file-opener registry:
if (isOfficeFile(path)) navigate({ to: "/office", search: { path } });
```

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
3. **The engine source is a third-party release** (`sweetwisdom/onlyoffice-web-local`,
   release-13). Before production, build our own package, host it on our S3
   and bake it into the Work golden image.
4. **Legacy formats save beside the original.** doc/xls/ppt are saved as a
   new .docx/.xlsx/.pptx next to the original.

## Licensing

The engine package is **AGPL-3.0** (ONLYOFFICE):

- It is served unmodified as a separate work under `/office-engine/`, next to
  its `LICENSE.txt`.
- The ONLYOFFICE logo and copyright must stay; white-labelling needs a
  commercial licence.
- If we modify the engine, we must publish the modified source to users.

Work's own code only talks to the engine through its public `DocsAPI` in the
browser.
