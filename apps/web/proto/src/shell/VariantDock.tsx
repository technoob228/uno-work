/**
 * Not part of the product: the floating switch between variants (three
 * sections × three variants, ★ = recommended) and the notes panel that
 * explains the variant picked last.
 */
import { EyeOffIcon, FlaskConicalIcon, PanelRightCloseIcon, PanelRightOpenIcon, StarIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useProto, type Section } from "../store";
import { SECTION_REC, SECTION_TITLE, VARIANTS } from "../variants";

const SECTIONS: ReadonlyArray<Section> = ["a", "b", "c"];

export function VariantDock() {
  const [hidden, setHidden] = useState(false);
  const focus = useProto((s) => s.focus);
  const a = useProto((s) => s.newVariant);
  const b = useProto((s) => s.assistantVariant);
  const c = useProto((s) => s.inboxVariant);
  const current: Record<Section, string> = { a, b, c };
  const setVariant = useProto((s) => s.setVariant);
  const notesOpen = useProto((s) => s.notesOpen);
  const setNotesOpen = useProto((s) => s.setNotesOpen);

  if (hidden) {
    return (
      <button
        type="button"
        onClick={() => setHidden(false)}
        className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-zinc-900/90 px-3 py-1.5 text-xs text-white shadow-lg"
      >
        <FlaskConicalIcon className="size-3.5" /> Variants
      </button>
    );
  }

  return (
    <div className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-2xl bg-zinc-900/94 p-1.5 text-xs shadow-2xl ring-1 ring-black/20 backdrop-blur">
      {SECTIONS.map((section, si) => (
        <div key={section} className="flex items-center gap-0.5">
          {si > 0 ? <span className="mx-1 h-7 w-px bg-white/15" /> : null}
          <span className={cn("px-1.5 text-[11px] font-bold", focus === section ? "text-white" : "text-zinc-500")}>{section.toUpperCase()}</span>
          {VARIANTS[section].map((v) => {
            const active = current[section] === v.id;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => setVariant(section, v.id)}
                className={cn(
                  "flex flex-col items-start whitespace-nowrap rounded-lg px-2 py-1 text-left transition-colors",
                  active ? (focus === section ? "bg-white text-zinc-900" : "bg-white/20 text-white") : "text-zinc-300 hover:bg-white/10 hover:text-white",
                )}
              >
                <span className="flex items-center gap-1 font-medium">
                  {v.label}
                  {v.rec ? <StarIcon className="size-2.5 fill-amber-400 text-amber-400" /> : null}
                </span>
                <span className="text-[10px] opacity-60">{v.hint}</span>
              </button>
            );
          })}
        </div>
      ))}
      <span className="mx-1 h-7 w-px bg-white/15" />
      <button type="button" aria-label="Notes" title="Notes" onClick={() => setNotesOpen(!notesOpen)} className="rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white">
        {notesOpen ? <PanelRightCloseIcon className="size-3.5" /> : <PanelRightOpenIcon className="size-3.5" />}
      </button>
      <button type="button" aria-label="Hide" onClick={() => setHidden(true)} className="rounded-lg p-2 text-zinc-400 hover:bg-white/10 hover:text-white">
        <EyeOffIcon className="size-3.5" />
      </button>
    </div>
  );
}

export function NotesPanel() {
  const focus = useProto((s) => s.focus);
  const current = useProto((s) => (focus === "a" ? s.newVariant : focus === "b" ? s.assistantVariant : s.inboxVariant));
  const setNotesOpen = useProto((s) => s.setNotesOpen);
  const note = VARIANTS[focus].find((v) => v.id === current)!;
  return (
    <aside className="flex h-full w-[var(--notes-w)] shrink-0 flex-col border-l border-border bg-amber-50/40 dark:bg-amber-500/5">
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b px-4">
        <FlaskConicalIcon className="size-4 text-amber-600" />
        <span className="text-sm font-medium">{SECTION_TITLE[focus]}</span>
        <button type="button" onClick={() => setNotesOpen(false)} className="ml-auto rounded p-1 text-muted-foreground hover:text-foreground">
          <PanelRightCloseIcon className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-24 text-[13px] leading-relaxed">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-foreground px-1.5 py-0.5 text-[11px] font-semibold text-background">{note.id.toUpperCase()}</span>
          {note.rec ? (
            <span className="flex items-center gap-1 rounded-full bg-amber-400/20 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
              <StarIcon className="size-3 fill-current" /> Рекомендую
            </span>
          ) : null}
          <span className="ml-auto rounded-md border px-1.5 py-0.5 text-[11px] font-semibold" title={note.costWhy}>
            Цена: {note.cost}
          </span>
        </div>
        <h3 className="mt-2 text-base font-semibold leading-snug">{note.title}</h3>
        <Block title="Что решает" items={note.solves} tone="text-emerald-700 dark:text-emerald-400" mark="+" />
        <Block title="Компромиссы" items={note.tradeoffs} tone="text-rose-700 dark:text-rose-400" mark="−" />
        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Цена сборки · {note.cost}</div>
          <p className="mt-1 text-muted-foreground">{note.costWhy}</p>
        </div>
        <div className="mt-4 rounded-lg border border-dashed p-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Попробуй</div>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {note.tryIt.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div className="mt-4 rounded-lg bg-amber-400/10 p-2.5">
          <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">
            <StarIcon className="size-3 fill-current" /> Рекомендация по разделу
          </div>
          <p className="mt-1">{SECTION_REC[focus]}</p>
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">
          Во всех вариантах: подсвечена только строка открытого экрана; Home и Inbox не прячут список чатов (баг 0.0.80 с «двумя серыми строками»).
        </p>
      </div>
    </aside>
  );
}

function Block({ title, items, tone, mark }: { title: string; items: ReadonlyArray<string>; tone: string; mark: string }) {
  return (
    <div className="mt-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <ul className="mt-1 space-y-1.5">
        {items.map((i) => (
          <li key={i} className="flex gap-2">
            <span className={cn("font-bold", tone)}>{mark}</span>
            <span>{i}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
