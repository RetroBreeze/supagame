import type { LocalStore } from '../../packages/sdk-ts/src/offline-saves.js';
export function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function memoryStore<T>(): LocalStore<T> {
  const rows = new Map<string, T>();
  return {
    async read(key) { return structuredClone(rows.get(key) ?? null); },
    async update(key, change) {
      const value = change(structuredClone(rows.get(key) ?? null));
      rows.set(key, structuredClone(value));
      return structuredClone(value);
    },
  };
}
export const saveRecord = {
  slot: 'profile', revision: 1, schemaVersion: 1, kind: 'json' as const, metadata: {},
  sizeBytes: 20, deleted: false, objectPath: null,
  createdAt: '2026-11-12T00:00:00Z', updatedAt: '2026-11-12T00:00:00Z', data: { coins: 1 },
};
