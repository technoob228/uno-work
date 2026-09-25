import { Loader2Icon } from "lucide-react";

import type { OfficePreviewBlock, OfficePreviewModel } from "./officePreviewModel";

function PreviewTable({
  rows,
  grid,
}: {
  rows: ReadonlyArray<ReadonlyArray<string>>;
  grid: boolean;
}) {
  return (
    <table
      className={
        grid
          ? "w-full border-collapse text-[12px] tabular-nums"
          : "my-3 w-full border-collapse text-[13px]"
      }
    >
      <tbody>
        {rows.map((row, r) => (
          // oxlint-disable-next-line react/no-array-index-key -- static, never reordered
          <tr key={r}>
            {row.map((cell, c) => (
              <td
                // oxlint-disable-next-line react/no-array-index-key -- static, never reordered
                key={c}
                className="max-w-48 truncate border border-neutral-200 px-2 py-1 align-top text-neutral-800"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PreviewBlock({ block, grid }: { block: OfficePreviewBlock; grid: boolean }) {
  switch (block.kind) {
    case "heading":
      return block.level === 1 ? (
        <h1 className="mt-2 mb-3 text-2xl font-semibold text-neutral-900">{block.text}</h1>
      ) : (
        <h2
          className={
            block.level === 2
              ? "mt-5 mb-2 text-lg font-semibold text-neutral-900"
              : "mt-4 mb-1 text-base font-semibold text-neutral-900"
          }
        >
          {block.text}
        </h2>
      );
    case "listItem":
      return (
        <li className="ml-5 list-disc text-[14px] leading-6 text-neutral-800">{block.text}</li>
      );
    case "table":
      return <PreviewTable rows={block.rows} grid={grid} />;
    case "slide":
      return (
        <section className="mb-4 aspect-video w-full overflow-hidden rounded-md border border-neutral-200 bg-white p-6 shadow-sm">
          {block.lines.map((line, i) =>
            i === 0 ? (
              // oxlint-disable-next-line react/no-array-index-key -- static, never reordered
              <p key={i} className="mb-3 text-xl font-semibold text-neutral-900">
                {line}
              </p>
            ) : (
              // oxlint-disable-next-line react/no-array-index-key -- static, never reordered
              <p key={i} className="text-[14px] leading-6 text-neutral-700">
                {line}
              </p>
            ),
          )}
        </section>
      );
    default:
      return <p className="mb-2 text-[14px] leading-6 text-neutral-800">{block.text}</p>;
  }
}

/**
 * The document's text while the editor starts (officePreviewModel.ts). Read-only,
 * replaced by the editor once the document is drawn.
 */
export function OfficePreview({
  model,
  documentKind,
  label,
}: {
  model: OfficePreviewModel;
  documentKind: "word" | "cell" | "slide";
  label: string;
}) {
  const grid = documentKind === "cell";
  return (
    <div
      className="absolute inset-0 overflow-hidden bg-neutral-100 dark:bg-neutral-200"
      data-testid="office-preview"
      aria-busy="true"
    >
      <div className="pointer-events-none absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-900/85 px-3 py-1 text-xs text-white shadow">
        <Loader2Icon className="size-3.5 animate-spin" />
        {label}
      </div>
      <div className="h-full overflow-hidden px-4 pt-14">
        <article
          className={
            grid
              ? "mx-auto w-full max-w-5xl bg-white p-2 shadow-sm"
              : documentKind === "slide"
                ? "mx-auto w-full max-w-3xl"
                : "mx-auto min-h-full w-full max-w-[816px] bg-white px-16 py-14 shadow-sm"
          }
        >
          {model.blocks.map((block, i) => (
            // oxlint-disable-next-line react/no-array-index-key -- static, never reordered
            <PreviewBlock key={i} block={block} grid={grid} />
          ))}
          {model.truncated ? <p className="mt-4 text-xs text-neutral-400">…</p> : null}
        </article>
      </div>
    </div>
  );
}
