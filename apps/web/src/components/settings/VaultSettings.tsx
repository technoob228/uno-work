import {
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CredentialImportItem, CredentialId, CredentialMetadata } from "@t3tools/contracts";

import { ensureLocalApi } from "../../localApi";
import { useFeatureFlag } from "../../hooks/useFeatureFlags";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { FeatureDisabledPanel } from "./FeatureDisabledPanel";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { toastManager } from "../ui/toast";

const ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";
const ROW_INNER_CLASSNAME = "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

interface CredentialFormState {
  readonly label: string;
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly notes: string;
}

const EMPTY_FORM: CredentialFormState = {
  label: "",
  url: "",
  username: "",
  password: "",
  notes: "",
};

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Parse pasted import text into import items. Accepts either a JSON array of
 * `{ url, username, password, label?, notes? }` objects, or CSV where each line
 * is `url,username,password[,label][,notes]`. A leading header row (first cell
 * "url") is skipped.
 */
function parseImportText(text: string): readonly CredentialImportItem[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    const array = Array.isArray(parsed) ? parsed : [parsed];
    const items: CredentialImportItem[] = [];
    for (const entry of array) {
      if (entry === null || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : "";
      const username = typeof record.username === "string" ? record.username : "";
      const password = typeof record.password === "string" ? record.password : "";
      if (url.length === 0 && username.length === 0 && password.length === 0) continue;
      items.push({
        url,
        username,
        password,
        ...(typeof record.label === "string" && record.label.length > 0
          ? { label: record.label }
          : {}),
        ...(typeof record.notes === "string" && record.notes.length > 0
          ? { notes: record.notes }
          : {}),
      });
    }
    return items;
  }

  const items: CredentialImportItem[] = [];
  const lines = trimmed.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.every((cell) => cell.length === 0)) continue;
    if (index === 0 && cells[0]?.toLowerCase() === "url") continue;
    const [url = "", username = "", password = "", label, notes] = cells;
    if (url.length === 0 && username.length === 0 && password.length === 0) continue;
    items.push({
      url,
      username,
      password,
      ...(label && label.length > 0 ? { label } : {}),
      ...(notes && notes.length > 0 ? { notes } : {}),
    });
  }
  return items;
}

export function VaultSettings() {
  const vaultEnabled = useFeatureFlag("vault");
  const unoApiKey = useSettings((settings) => settings.uno?.apiKey ?? "");
  const agentAccess = useSettings((settings) => settings.uno?.agentAccess ?? "read");
  const credentialsSync = useSettings((settings) => settings.uno?.credentialsSync ?? false);
  const { updateSettings } = useUpdateSettings();
  const [credentials, setCredentials] = useState<readonly CredentialMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<CredentialId | null>(null);
  const [form, setForm] = useState<CredentialFormState>(EMPTY_FORM);
  const [isSaving, setIsSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<CredentialMetadata | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const [syncing, setSyncing] = useState<"push" | "pull" | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [isImporting, setIsImporting] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await ensureLocalApi().vault.list();
      setCredentials(list);
      setLoadError(null);
    } catch (error) {
      setLoadError(toErrorMessage(error, "Failed to load credentials."));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sortedCredentials = useMemo(
    () =>
      credentials.toSorted((a, b) =>
        (a.label || a.url || a.username).localeCompare(b.label || b.url || b.username),
      ),
    [credentials],
  );

  const openAddDialog = useCallback(() => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  }, []);

  const openEditDialog = useCallback((credential: CredentialMetadata) => {
    setEditingId(credential.id);
    setForm({
      label: credential.label,
      url: credential.url,
      username: credential.username,
      password: "",
      notes: credential.notes ?? "",
    });
    setFormOpen(true);
  }, []);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await ensureLocalApi().vault.upsert({
        ...(editingId ? { id: editingId } : {}),
        input: {
          label: form.label.trim(),
          url: form.url.trim(),
          username: form.username.trim(),
          password: form.password,
          notes: form.notes.trim(),
        },
      });
      setFormOpen(false);
      await refresh();
      toastManager.add({
        type: "success",
        title: editingId ? "Credential updated" : "Credential added",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save credential",
        description: toErrorMessage(error, "Save failed."),
      });
    } finally {
      setIsSaving(false);
    }
  }, [editingId, form, refresh]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await ensureLocalApi().vault.delete({ id: deleteTarget.id });
      setDeleteTarget(null);
      await refresh();
      toastManager.add({ type: "success", title: "Credential deleted" });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not delete credential",
        description: toErrorMessage(error, "Delete failed."),
      });
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, refresh]);

  const handleImport = useCallback(async () => {
    setIsImporting(true);
    try {
      const items = parseImportText(importText);
      if (items.length === 0) {
        toastManager.add({
          type: "error",
          title: "Nothing to import",
          description: "Paste CSV (url,username,password per line) or a JSON array.",
        });
        return;
      }
      const result = await ensureLocalApi().vault.import({ items });
      setImportOpen(false);
      setImportText("");
      await refresh();
      toastManager.add({
        type: "success",
        title: `Imported ${result.imported} credential${result.imported === 1 ? "" : "s"}`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Import failed",
        description: toErrorMessage(error, "Could not parse the pasted credentials."),
      });
    } finally {
      setIsImporting(false);
    }
  }, [importText, refresh]);

  const canSave = form.url.trim().length > 0 && form.username.trim().length > 0;

  const runSync = useCallback(
    async (direction: "push" | "pull") => {
      setSyncing(direction);
      try {
        const result = await ensureLocalApi().vault.sync({ direction });
        if (!result.ok) {
          toastManager.add({
            type: "error",
            title:
              direction === "push"
                ? "Не удалось отправить в аккаунт Uno"
                : "Не удалось забрать из аккаунта Uno",
            description: result.error ?? "Неизвестная причина.",
          });
          return;
        }
        if (direction === "pull") await refresh();
        toastManager.add({
          type: "success",
          title:
            direction === "push"
              ? `Отправлено в аккаунт Uno: ${result.count ?? 0}`
              : `Забрано из аккаунта Uno: ${result.count ?? 0}`,
          description:
            direction === "push"
              ? "Другие машины получат их при включённой синхронизации."
              : "Локальное хранилище заменено состоянием из аккаунта.",
        });
      } finally {
        setSyncing(null);
      }
    },
    [refresh],
  );

  if (!vaultEnabled) {
    return <FeatureDisabledPanel feature="Credentials" />;
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Одно хранилище на все машины"
        icon={<RefreshCwIcon className="size-3.5" />}
      >
        <div className={ROW_CLASSNAME}>
          <div className={ROW_INNER_CLASSNAME}>
            <div className="min-w-0 flex-1 space-y-1">
              <h3 className="text-sm font-medium text-foreground">
                Синхронизация через аккаунт Uno
              </h3>
              <p className="text-xs text-muted-foreground/70">
                Логины лежат на той машине, где работает демон: у браузерной версии — на боксе, у
                десктопа — локально. Включите синхронизацию, чтобы хранить их в аккаунте Uno и
                видеть один и тот же список везде. Обмен идёт набором целиком: «Отправить» заменяет
                состояние в аккаунте, «Забрать» — локальное. Новая машина с пустым хранилищем
                подтягивает логины сама при старте.
              </p>
              {!unoApiKey ? (
                <p className="text-xs text-amber-500">
                  Нужен ключ аккаунта Uno — Settings → Uno account.
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                role="switch"
                aria-checked={credentialsSync}
                onClick={() =>
                  void updateSettings({
                    uno: { apiKey: unoApiKey, agentAccess, credentialsSync: !credentialsSync },
                  })
                }
                className={
                  credentialsSync
                    ? "rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
                    : "rounded-md border border-input px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent"
                }
              >
                {credentialsSync ? "Включена" : "Выключена"}
              </button>
              <Button
                size="xs"
                variant="outline"
                disabled={!credentialsSync || syncing !== null}
                onClick={() => void runSync("push")}
              >
                {syncing === "push" ? "…" : "Отправить"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!credentialsSync || syncing !== null}
                onClick={() => void runSync("pull")}
              >
                {syncing === "pull" ? "…" : "Забрать"}
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Credentials"
        icon={<KeyRoundIcon className="size-3.5" />}
        headerAction={
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => setImportOpen(true)}>
              <UploadIcon className="size-3" />
              Import
            </Button>
            <Button size="xs" variant="default" onClick={openAddDialog}>
              <PlusIcon className="size-3" />
              Add
            </Button>
          </div>
        }
      >
        {isLoading ? (
          <div className={ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground/60">Loading credentials…</p>
          </div>
        ) : loadError ? (
          <div className={ROW_CLASSNAME}>
            <p className="text-xs text-destructive">{loadError}</p>
          </div>
        ) : sortedCredentials.length === 0 ? (
          <div className={ROW_CLASSNAME}>
            <p className="text-xs text-muted-foreground/60">
              No credentials yet. Add website logins here instead of pasting them into chat — the
              password stays on the computer and never reaches the model.
            </p>
          </div>
        ) : (
          sortedCredentials.map((credential) => (
            <div key={credential.id} className={ROW_CLASSNAME}>
              <div className={ROW_INNER_CLASSNAME}>
                <div className="min-w-0 flex-1 space-y-1">
                  <h3 className="truncate text-sm font-medium text-foreground">
                    {credential.label || credential.url || credential.username}
                  </h3>
                  <p className="truncate text-xs text-muted-foreground">
                    {[credential.url, credential.username].filter(Boolean).join(" · ")}
                  </p>
                  <p className="font-mono text-xs tracking-widest text-muted-foreground/60">
                    •••••••••••
                  </p>
                  {credential.notes ? (
                    <p className="truncate text-[11px] text-muted-foreground/70">
                      {credential.notes}
                    </p>
                  ) : null}
                </div>
                <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => openEditDialog(credential)}
                    aria-label={`Edit ${credential.label || credential.url}`}
                  >
                    <PencilIcon className="size-3" />
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    onClick={() => setDeleteTarget(credential)}
                    aria-label={`Delete ${credential.label || credential.url}`}
                  >
                    <Trash2Icon className="size-3" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          ))
        )}
      </SettingsSection>

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit credential" : "Add credential"}</DialogTitle>
            <DialogDescription>
              Passwords are stored on the computer and never returned to the app.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Label</span>
              <Input
                value={form.label}
                onChange={(event) => setForm((prev) => ({ ...prev, label: event.target.value }))}
                placeholder="e.g. Company GitHub"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">URL</span>
              <Input
                value={form.url}
                onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
                placeholder="https://example.com/login"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Username</span>
              <Input
                value={form.username}
                onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
                placeholder="you@example.com"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Password</span>
              <Input
                type="password"
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder={editingId ? "Leave blank to keep current" : "Password"}
                autoComplete="new-password"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">
                Notes (optional)
              </span>
              <Textarea
                value={form.notes}
                onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                rows={2}
              />
            </label>
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button variant="outline" disabled={isSaving} />}>
              Cancel
            </DialogClose>
            <Button disabled={!canSave || isSaving} onClick={() => void handleSave()}>
              {isSaving ? "Saving…" : editingId ? "Save changes" : "Add credential"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import credentials</DialogTitle>
            <DialogDescription>
              Paste CSV — one <code>url,username,password</code> per line (an optional header row is
              skipped) — or a JSON array of {"{ url, username, password }"} objects.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Textarea
              value={importText}
              onChange={(event) => setImportText(event.target.value)}
              rows={8}
              className="font-mono text-xs"
              placeholder={"https://example.com,alice,s3cret\nhttps://other.com,bob,hunter2"}
            />
          </DialogPanel>
          <DialogFooter variant="bare">
            <DialogClose render={<Button variant="outline" disabled={isImporting} />}>
              Cancel
            </DialogClose>
            <Button
              disabled={isImporting || importText.trim().length === 0}
              onClick={() => void handleImport()}
            >
              {isImporting ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete “{deleteTarget?.label || deleteTarget?.url || deleteTarget?.username}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the stored login and its password. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={isDeleting} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={isDeleting} onClick={() => void handleDelete()}>
              {isDeleting ? "Deleting…" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
