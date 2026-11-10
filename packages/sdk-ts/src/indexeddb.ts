import type { LocalStore } from "./offline-saves.js";
/** A durable, transactionally serialized store. No memory-only fallback is hidden. */
export function createIndexedDbStore<T>(
  name = "supagame-saves",
): LocalStore<T> {
  let database: Promise<IDBDatabase> | undefined;
  function open() {
    return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (!globalThis.indexedDB) {
        reject(new Error("Durable browser storage is unavailable."));
        return;
      }
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("records");
      request.onerror = () => {
        database = undefined;
        reject(new Error("Could not open durable browser storage."));
      };
      request.onblocked = () => {
        database = undefined;
        reject(new Error("Browser storage upgrade is blocked by another tab."));
      };
      request.onsuccess = () => {
        request.result.onversionchange = () => {
          request.result.close();
          database = undefined;
        };
        resolve(request.result);
      };
    }));
  }
  return {
    async read(key) {
      const db = await open();
      return new Promise<T | null>((resolve, reject) => {
        const tx = db.transaction("records", "readonly");
        const request = tx.objectStore("records").get(key);
        tx.oncomplete = () =>
          resolve((request.result as T | undefined) ?? null);
        tx.onabort = tx.onerror = () =>
          reject(new Error("Could not read durable save."));
      });
    },
    async update(key, change) {
      const db = await open();
      return new Promise<T>((resolve, reject) => {
        const tx = db.transaction("records", "readwrite", {
            durability: "strict",
          }),
          store = tx.objectStore("records");
        const request = store.get(key);
        let next: T;
        request.onsuccess = () => {
          try {
            next = change((request.result as T | undefined) ?? null);
            store.put(next, key);
          } catch (error) {
            tx.abort();
            reject(error);
          }
        };
        tx.oncomplete = () => resolve(next);
        tx.onabort = tx.onerror = () =>
          reject(
            new Error(
              "Could not persist save; local storage may be full or unavailable.",
            ),
          );
      });
    },
  };
}
