/**
 * Settings → Keyboard: every action with its keys, a search, and a new key by
 * pressing it (Misha 01.11, upstream T3 Code's KeybindingsSettings without its
 * `when` editor). Written to keybindings.json on the computer; the app picks
 * the change up from the server's stream, nothing restarts.
 */
import { SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { KeybindingCommand } from "@t3tools/contracts";

import { useDevMode } from "../../devMode";
import { isElectron } from "../../env";
import { readLocalApi } from "../../localApi";
import { useServerKeybindings } from "../../rpc/serverState";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
import { toastManager } from "../ui/toast";
import {
  browserKeepsShortcut,
  buildKeyRows,
  filterKeyRows,
  groupKeyRows,
  keybindingFromKeyboardEvent,
  keyConflicts,
  type KeyRow,
} from "./KeyboardSettings.logic";
import { SettingResetButton, SettingsPageContainer, SettingsSection } from "./settingsLayout";

function KeyRowView({
  row,
  conflicts,
  recording,
  onRecord,
  onCancel,
  onChoose,
  onReset,
}: {
  row: KeyRow;
  conflicts: ReadonlyArray<string>;
  recording: boolean;
  onRecord: () => void;
  onCancel: () => void;
  onChoose: (key: string) => void;
  onReset: () => void;
}) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!recording) return;
    buttonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        onCancel();
        return;
      }
      const key = keybindingFromKeyboardEvent(event);
      if (key) onChoose(key);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onChoose, recording]);

  const browserKeeps = !isElectron && row.keys.some(browserKeepsShortcut);
  return (
    <div
      className="border-t border-border/60 px-4 py-2.5 first:border-t-0 sm:px-5"
      data-testid={`keyboard-row-${row.command}`}
    >
      <div className="flex min-h-7 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[13px] text-foreground">{row.label}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {row.changed ? <SettingResetButton label={row.label} onClick={onReset} /> : null}
          <button
            ref={buttonRef}
            type="button"
            data-keybinding-capture
            aria-label={`Change keys for ${row.label}`}
            onClick={recording ? onCancel : onRecord}
            onBlur={recording ? onCancel : undefined}
            className="flex min-h-7 items-center gap-1 rounded-md px-1.5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          >
            {recording ? (
              <span className="text-xs text-muted-foreground">Press keys…</span>
            ) : (
              row.labels.map((label) => <Kbd key={label}>{label}</Kbd>)
            )}
          </button>
        </span>
      </div>
      {!recording && (conflicts.length > 0 || browserKeeps) ? (
        <p className="flex items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
          <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
          {conflicts.length > 0
            ? `Same keys as ${conflicts.join(", ")}`
            : "A browser tab keeps these keys for itself"}
        </p>
      ) : null}
    </div>
  );
}

export function KeyboardSettings() {
  const keybindings = useServerKeybindings();
  const devMode = useDevMode();
  const rows = useMemo(() => buildKeyRows(keybindings, { devMode }), [devMode, keybindings]);
  const [query, setQuery] = useState("");
  const [recording, setRecording] = useState<KeybindingCommand | null>(null);
  const sections = useMemo(() => groupKeyRows(filterKeyRows(rows, query)), [query, rows]);

  const cancel = useCallback(() => setRecording(null), []);
  const run = useCallback(async (change: () => Promise<unknown> | undefined) => {
    try {
      await change();
    } catch {
      toastManager.add({
        type: "error",
        title: "Couldn't save the keys",
        description: "Update Uno Work on this computer and try again.",
      });
    }
  }, []);

  return (
    <SettingsPageContainer>
      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          nativeInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search"
          aria-label="Search keys"
          className="[&_input]:pl-8"
          data-testid="keyboard-search"
        />
      </div>
      {!isElectron ? (
        <p className="-mt-5 px-1 text-xs text-muted-foreground">
          In a browser tab some keys stay with the browser. The Uno Work app gets them all.
        </p>
      ) : null}
      {sections.map((section) => (
        <SettingsSection key={section.title} title={section.title}>
          {section.rows.map((row) => (
            <KeyRowView
              key={row.command}
              row={row}
              conflicts={row.keys.flatMap((key) =>
                keyConflicts(rows, {
                  command: row.command,
                  key,
                  ...(row.when ? { when: row.when } : {}),
                }),
              )}
              recording={recording === row.command}
              onRecord={() => setRecording(row.command)}
              onCancel={cancel}
              onChoose={(key) => {
                setRecording(null);
                void run(() =>
                  readLocalApi()?.server.upsertKeybinding({
                    key,
                    command: row.command,
                    ...(row.when ? { when: row.when } : {}),
                  }),
                );
              }}
              onReset={() =>
                void run(() => readLocalApi()?.server.removeKeybinding({ command: row.command }))
              }
            />
          ))}
        </SettingsSection>
      ))}
      {sections.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">Nothing found.</p>
      ) : null}
    </SettingsPageContainer>
  );
}
