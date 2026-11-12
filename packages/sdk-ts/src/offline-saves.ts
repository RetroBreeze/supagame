import type { TransferSave } from './account-saves.js';
import { AccountError } from './accounts.js';
import type { SaveRecord } from "@retrobreeze/supagame-contracts";
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
  async function checked<T>(player: string, work: () => Promise<T>): Promise<T> {
    await same(player);
    let value: T;
    try { value = await work(); }
    catch (error) { await same(player); throw error; }
    await same(player);
    return value;
  }
  const read = (key: string, player: string) => checked(player, () => options.store.read(key));
  const update = (key: string, player: string, change: (state: OfflineEntry | null) => OfflineEntry) =>
    checked(player, () => options.store.update(key, change));
  const matchesPending = (state: OfflineEntry, pending: PendingSave) =>
    state.pending[0]?.options.operationId === pending.options.operationId &&
    state.pending[0]?.options.expectedRevision === pending.options.expectedRevision;
  function hydrate(previous: OfflineEntry | null, cloud: Saved, binary?: Blob): OfflineEntry {
    const state = previous ?? empty();
    if (cloud.revision < Math.max(state.cloud?.revision ?? 0, state.conflict?.revision ?? 0)) return state;
    const next = { ...state, cloud };
    if (binary) next.binary = binary;
    else if (cloud.kind !== 'binary' || cloud.revision !== state.cloud?.revision) delete next.binary;
    return next;
  }
  const paused = new Set<string>();
  function writable(player: string) { if (paused.has(player)) throw new AccountError('TRANSITION_PENDING', 'Account transition prepared. Resume this identity explicitly before changing its offline saves.'); }
  const active = new Map<string, Promise<OfflineEntry | null>>();
  const api = {
    async prepareAccountSwitch(slots: readonly string[]) {
      const player = await options.playerId();
      if (!player) throw new AuthenticationError();
      paused.add(player);
      // Drain existing syncs before freezing a recoverable view. Failed pending writes stay staged.
      await Promise.allSettled([...active.values()]);
      const local: TransferSave[] = [];
      for (const slot of new Set(slots)) {
        const state = await read(JSON.stringify([options.namespace, player, slot]), player), pending = state?.pending.at(-1);
        if (!pending) continue;
        local.push({slot, kind: pending.kind ?? 'json',
          ...(pending.kind === 'binary' ? {binary: pending.data as Blob} : {data: pending.data}),
          ...(pending.options.schemaVersion ? {schemaVersion:pending.options.schemaVersion}:{}),
          ...(pending.options.metadata ? {metadata:pending.options.metadata}:{})});
      }
      await same(player);
      return checked(player, () => options.saves.prepareAccountSwitch({ local, beforeSnapshot: async () => { await same(player); return []; } }));
    },
    async resumeAfterAccountSwitch() { const player = await options.playerId(); if (player) paused.delete(player); },
    async local(slot: string): Promise<OfflineEntry | null> {
      const { key, player } = await scope(slot);
      const value = await read(key, player);
      await same(player);
      return value;
    },
    async load(slot: string): Promise<OfflineEntry> {
      const { key, player } = await scope(slot);
      const cloud = await checked(player, () => options.saves.load(slot));
      await same(player);
      return update(key, player, previous => hydrate(previous, cloud));
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
      writable(player);
      await same(player);
      return update(key, player, (previous) => {
        writable(player);
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
      const result = await checked(player, () => options.saves.loadBinary(slot));
      await same(player);
      return update(key, player, previous => hydrate(previous, result.save, result.data));
    },
    async stageBinary(
      slot: string,
      data: Blob,
      settings: SaveOptions = {},
    ): Promise<OfflineEntry> {
      const { key, player } = await scope(slot);
      writable(player);
      await same(player);
      return update(key, player, (previous) => {
        writable(player);
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
      writable(player);
      await same(player);
      return update(key, player, (previous) => {
        writable(player);
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
      writable(player);
      await same(player);
      const observed = await read(key, player) ?? empty();
      const queue = (s: OfflineEntry) => JSON.stringify(s.pending.map(p => [p.options.operationId, p.options.expectedRevision]));
      return update(key, player, (previous) => {
        writable(player);
        const state = previous ?? empty();
        if (queue(state) !== queue(observed) || state.cloud?.revision !== observed.cloud?.revision ||
          state.conflict?.revision !== observed.conflict?.revision ||
          expectedRevision < Math.max(state.cloud?.revision ?? 0, state.conflict?.revision ?? 0))
          throw new SaveConflictError(state.conflict ?? state.cloud, 'The local queue changed during resolution. Review it again.');
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
      writable(player);
      const running = active.get(key);
      if (running) return checked(player, () => running);
      const work = (async () => {
        for (;;) {
          await same(player);
          const state = await read(key, player);
          const pending = state?.pending[0];
          if (!pending) return state;
          if (state && Object.hasOwn(state, "conflict"))
            throw new SaveConflictError(state.conflict ?? null);
          try {
            const settings = { ...pending.options, expectedPlayerId: player };
            const cloud = await checked(player, () => (pending.kind === "delete"
              ? options.saves.delete(slot, settings)
              : pending.kind === "binary"
                ? options.saves.saveBinary(slot, pending.data as Blob, settings)
                : options.saves.save(slot, pending.data, settings)));
            await same(player);
            await update(key, player, (current) => {
              const next = current ?? empty();
              // Another tab may have acknowledged this exact operation already.
              if (!matchesPending(next, pending)) return next;
              const updated = hydrate(next, cloud, pending.kind === 'binary' ? pending.data as Blob : undefined);
              return { ...updated, pending: next.pending.slice(1) };
            });
          } catch (error) {
            if (error instanceof SaveConflictError)
              await update(key, player, (current) => {
                const next = current ?? empty();
                if (!matchesPending(next, pending) ||
                  (error.current?.revision ?? 0) < Math.max(next.cloud?.revision ?? 0, next.conflict?.revision ?? 0)) return next;
                return { ...next, conflict: error.current };
              });
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
