import type { SaveRecord } from "@supagame/contracts";
import type { Saves, SaveOptions, Saved } from "./saves.js";
import { AuthenticationError, SaveConflictError } from "./errors.js";
import { operationId, validateJson } from "./save-values.js";

/** update must be an atomic read/modify/write transaction, including across tabs. */
export interface LocalStore<T> {
  read(key: string): Promise<T | null>;
  update(key: string, change: (previous: T | null) => T): Promise<T>;
}
export interface PendingSave {
  kind?: "json" | "binary" | "delete";
  data: unknown;
  options: SaveOptions & { operationId: string; expectedRevision: number };
}
export interface OfflineEntry {
  cloud: Saved | null;
  pending: PendingSave[];
  conflict?: SaveRecord | null;
  /** Explicit resolutions retain the replaced local queue for application recovery. */
  history?: PendingSave[][];
  binary?: Blob;
}
export type SaveStore = LocalStore<OfflineEntry>;
export function createOfflineSaves(options: {
  saves: Saves;
  store: SaveStore;
  playerId: () => Promise<string | null>;
  namespace: string;
}) {
  const empty = (): OfflineEntry => ({ cloud: null, pending: [] });
  async function scope(slot: string) {
    const player = await options.playerId();
    if (!player)
      throw new AuthenticationError(
        "Restore the original player session before using local saves.",
      );
    return { player, key: JSON.stringify([options.namespace, player, slot]) };
  }
  async function same(player: string) {
    if ((await options.playerId()) !== player)
      throw new AuthenticationError("The player changed while synchronizing.");
  }
  const active = new Map<string, Promise<OfflineEntry | null>>();
  const api = {
    async local(slot: string): Promise<OfflineEntry | null> {
      const { key, player } = await scope(slot);
      const value = await options.store.read(key);
      await same(player);
      return value;
    },
    async load(slot: string): Promise<OfflineEntry> {
      const { key, player } = await scope(slot);
      const cloud = await options.saves.load(slot);
      await same(player);
      return options.store.update(key, (previous) => ({
        ...(previous ?? empty()),
        cloud,
      }));
    },
    /** Durable staging succeeds before any network request is attempted. */
    async stage(
      slot: string,
      data: unknown,
      settings: SaveOptions = {},
    ): Promise<OfflineEntry> {
      validateJson(data);
      const snapshot = structuredClone(data);
      const { key, player } = await scope(slot);
      await same(player);
      return options.store.update(key, (previous) => {
        const state = previous ?? empty();
        const last = state.pending.at(-1);
        const expectedRevision =
          settings.expectedRevision ??
          (last
            ? last.options.expectedRevision + 1
            : (state.cloud?.revision ?? 0));
        return {
          ...state,
          pending: [
            ...state.pending,
            {
              data: snapshot,
              options: {
                ...settings,
                operationId: settings.operationId ?? operationId(),
                expectedRevision,
              },
            },
          ],
        };
      });
    },
    async loadBinary(slot: string): Promise<OfflineEntry> {
      const { key, player } = await scope(slot);
      const result = await options.saves.loadBinary(slot);
      await same(player);
      return options.store.update(key, (previous) => ({
        ...(previous ?? empty()),
        cloud: result.save,
        binary: result.data,
      }));
    },
    async stageBinary(
      slot: string,
      data: Blob,
      settings: SaveOptions = {},
    ): Promise<OfflineEntry> {
      const { key, player } = await scope(slot);
      await same(player);
      return options.store.update(key, (previous) => {
        const state = previous ?? empty(),
          last = state.pending.at(-1);
        return {
          ...state,
          pending: [
            ...state.pending,
            {
              kind: "binary",
              data,
              options: {
                ...settings,
                operationId: settings.operationId ?? operationId(),
                expectedRevision:
                  settings.expectedRevision ??
                  (last
                    ? last.options.expectedRevision + 1
                    : (state.cloud?.revision ?? 0)),
              },
            },
          ],
        };
      });
    },
    async delete(slot: string): Promise<OfflineEntry> {
      const { key, player } = await scope(slot);
      await same(player);
      return options.store.update(key, (previous) => {
        const state = previous ?? empty(),
          last = state.pending.at(-1);
        return {
          ...state,
          pending: [
            ...state.pending,
            {
              kind: "delete",
              data: null,
              options: {
                operationId: operationId(),
                expectedRevision: last
                  ? last.options.expectedRevision + 1
                  : (state.cloud?.revision ?? 0),
              },
            },
          ],
        };
      });
    },
    async resolve(
      slot: string,
      data: unknown,
      expectedRevision: number,
    ): Promise<OfflineEntry> {
      validateJson(data);
      const { key, player } = await scope(slot);
      await same(player);
      return options.store.update(key, (previous) => {
        const state = previous ?? empty();
        return {
          cloud: state.cloud,
          pending: [
            {
              data: structuredClone(data),
              options: {
                ...state.pending.at(-1)?.options,
                expectedRevision,
                operationId: operationId(),
              },
            },
          ],
          history: [...(state.history ?? []), state.pending],
        };
      });
    },
    async sync(slot: string): Promise<OfflineEntry | null> {
      const { key, player } = await scope(slot);
      const running = active.get(key);
      if (running) return running;
      const work = (async () => {
        for (;;) {
          await same(player);
          const state = await options.store.read(key);
          const pending = state?.pending[0];
          if (!pending) return state;
          if (state && Object.hasOwn(state, "conflict"))
            throw new SaveConflictError(state.conflict ?? null);
          try {
            const settings = { ...pending.options, expectedPlayerId: player };
            const cloud = await (pending.kind === "delete"
              ? options.saves.delete(slot, settings)
              : pending.kind === "binary"
                ? options.saves.saveBinary(slot, pending.data as Blob, settings)
                : options.saves.save(slot, pending.data, settings));
            await same(player);
            await options.store.update(key, (current) => {
              const next = current ?? empty();
              // Another tab may have acknowledged this exact operation already.
              if (
                next.pending[0]?.options.operationId !==
                pending.options.operationId
              )
                return next;
              const updated = {
                ...next,
                cloud,
                pending: next.pending.slice(1),
              };
              if (pending.kind === "binary")
                updated.binary = pending.data as Blob;
              else delete updated.binary;
              return updated;
            });
          } catch (error) {
            if (error instanceof SaveConflictError)
              await options.store.update(key, (current) => ({
                ...(current ?? empty()),
                conflict: error.current,
              }));
            throw error; // Auth/permission/server errors are never offline successes.
          }
        }
      })();
      active.set(key, work);
      try {
        return await work;
      } finally {
        active.delete(key);
      }
    },
  };
  return api;
}
