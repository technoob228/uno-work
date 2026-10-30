/**
 * Where set-aside messages live: IndexedDB in this browser or app, because
 * they can hold pictures and files (localStorage would run out). Without
 * IndexedDB (private window, tests) they last until the page closes.
 */
const DB_NAME = "uno-work-stash";
const STORE = "stash";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Couldn't open the stash."));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  if (typeof indexedDB === "undefined") return null;
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = run(transaction.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Stash request failed."));
    });
  } finally {
    db.close();
  }
}

export async function readStash<T>(): Promise<T[]> {
  return (await withStore<T[]>("readonly", (store) => store.getAll())) ?? [];
}

export async function writeStashEntry<T extends { readonly id: string }>(entry: T): Promise<void> {
  await withStore("readwrite", (store) => store.put(entry));
}

export async function deleteStashEntry(id: string): Promise<void> {
  await withStore("readwrite", (store) => store.delete(id));
}
