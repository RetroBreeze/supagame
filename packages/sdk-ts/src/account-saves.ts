import type { SaveRecord } from "@supagame/contracts";
import {
  AccountError,
  verifiedAccount,
  type AccountContext,
  type AuthFlow,
} from "./accounts.js";
import type { SupabaseConnection } from "./auth.js";
import type { Saves, SaveOptions } from "./saves.js";
import { ApiError, SaveConflictError } from "./errors.js";
import { operationId, validateJson, type JsonValue } from "./save-values.js";

export interface TransferSave {
  slot: string;
  kind: "json" | "binary" | "delete";
  data?: unknown;
  binary?: Blob;
  schemaVersion?: number;
  metadata?: Record<string, JsonValue>;
  revision?: number;
}
export interface AccountTransition {
  id: string;
  sourcePlayerId: string;
}
export interface SwitchSlot {
  slot: string;
  guest: TransferSave | null;
  cloud: TransferSave | null;
}
export interface SwitchReview {
  targetPlayerId: string;
  slots: SwitchSlot[];
  previousReviews?: SwitchSlot[][];
}
export type SwitchStrategy = "keepCloud" | "keepGuest" | "merge" | "cancel";
export interface ResolveSwitchOptions {
  strategy: SwitchStrategy;
  targetPlayerId: string;
  confirmed: boolean;
  /** Backups are always retained; false is rejected. */
  backupExisting?: true;
  merge?: (slot: SwitchSlot) => TransferSave | Promise<TransferSave>;
}
export interface SwitchResult {
  status: "complete" | "cancelled";
  strategy: SwitchStrategy;
  targetPlayerId: string;
  completedSlots: string[];
}
export interface PrepareSwitchOptions {
  /** Include every unsynchronized local slot, including pending deletes/binary bytes. */
  local?: TransferSave[];
  /** Called before capturing remote state; pause application writes until resolution. */
  beforeSnapshot?: () => Promise<TransferSave[]>;
}
export interface AccountSaves {
  prepareAccountSwitch(
    options?: PrepareSwitchOptions,
  ): Promise<AccountTransition>;
  pendingAccountSwitch(): Promise<AccountTransition | null>;
  inspectAccountSwitch(
    transition: AccountTransition,
    options: { flowId: string; restart?: boolean },
  ): Promise<SwitchReview>;
  resolveAccountSwitch(
    transition: AccountTransition,
    options: ResolveSwitchOptions,
  ): Promise<SwitchResult>;
  getAccountSwitchRecovery(
    transition: AccountTransition,
  ): Promise<SwitchReview>;
  discardAccountSwitch(
    transition: AccountTransition,
    options: { acceptDataLoss: true },
  ): Promise<void>;
}
interface Write {
  value: TransferSave;
  operationId: string;
  expectedRevision: number;
  done?: boolean;
}
interface Journal {
  version: 1;
  id: string;
  sourcePlayerId: string;
  phase: "prepared" | "review" | "importing" | "complete";
  generation?: number;
  previousReviews?: SwitchSlot[][];
  conflicts?: Record<string, SaveRecord | null>;
  slots: SwitchSlot[];
  targetPlayerId?: string;
  strategy?: SwitchStrategy;
  writes?: Write[];
}
const MAX_FILE = 64 * 1024 * 1024,
  MAX_TOTAL = 128 * 1024 * 1024,
  MAX_SLOTS = 1000;
const invalid = () =>
  new AccountError(
    "INVALID_SNAPSHOT",
    "Invalid save snapshot. Keep the original data and prepare a new transition.",
  );
function size(value: TransferSave): number {
  if (
    !value ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.slot) ||
    value.slot === "cleanup" ||
    !["json", "binary", "delete"].includes(value.kind)
  )
    throw invalid();
  if (
    value.schemaVersion !== undefined &&
    (!Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1)
  )
    throw invalid();
  if (
    value.revision !== undefined &&
    (!Number.isSafeInteger(value.revision) || value.revision < 0)
  )
    throw invalid();
  validateJson(value.metadata ?? {});
  if (
    Array.isArray(value.metadata) ||
    value.metadata === null ||
    new TextEncoder().encode(JSON.stringify(value.metadata ?? {})).byteLength >
      4096
  )
    throw invalid();
  let bytes = 0;
  if (value.kind === "binary") {
    if (!(value.binary instanceof Blob) || value.binary.size < 1)
      throw invalid();
    bytes = value.binary.size;
  }
  if (value.kind === "json") {
    validateJson(value.data);
    bytes = new TextEncoder().encode(JSON.stringify(value.data)).byteLength;
    if (bytes > 1048576)
      throw new AccountError(
        "TRANSFER_TOO_LARGE",
        "JSON saves must fit the 1 MiB service limit. Use a binary slot for larger data.",
      );
  }
  if (bytes > MAX_FILE)
    throw new AccountError(
      "TRANSFER_TOO_LARGE",
      "A save exceeds the 64 MiB transfer limit. Export or reduce it before signing in; source data is unchanged.",
    );
  return bytes;
}
function validate(slots: SwitchSlot[]) {
  if (
    !Array.isArray(slots) ||
    slots.length > MAX_SLOTS ||
    new Set(slots.map((s) => s.slot)).size !== slots.length
  )
    throw invalid();
  let bytes = 0;
  for (const s of slots)
    for (const value of [s.guest, s.cloud])
      if (value) {
        if (value.slot !== s.slot) throw invalid();
        bytes += size(value);
      }
  if (bytes > MAX_TOTAL)
    throw new AccountError(
      "TRANSFER_TOO_LARGE",
      "Guest data and backups exceed the 128 MiB transfer budget. Export or reduce saves before continuing.",
    );
}
function snapshot(record: SaveRecord, binary?: Blob): TransferSave {
  return {
    slot: record.slot,
    kind: record.deleted ? "delete" : record.kind,
    revision: record.revision,
    schemaVersion: record.schemaVersion,
    metadata: record.metadata as Record<string, JsonValue>,
    ...(record.kind === "json"
      ? { data: record.data }
      : binary
        ? { binary }
        : {}),
  };
}
export function createAccountSaves(
  client: SupabaseConnection,
  saves: Saves,
  context: AccountContext,
): AccountSaves {
  const { store, key } = context;
  async function current(expected: string) {
    if ((await verifiedAccount(client)).id !== expected)
      throw new AccountError(
        "TRANSITION_MISMATCH",
        "The current account does not own this transition. Sign back into the intended account.",
      );
  }
  async function read(t: AccountTransition): Promise<Journal> {
    const j = (await store.read(key("transition", t.id))) as Journal | null;
    if (
      !j ||
      j.version !== 1 ||
      j.id !== t.id ||
      j.sourcePlayerId !== t.sourcePlayerId ||
      !["prepared", "review", "importing", "complete"].includes(j.phase)
    )
      throw invalid();
    validate(j.slots);
    return j;
  }
  async function persist(j: Journal) {
    validate(j.slots);
    await store.update(key("transition", j.id), () => j);
  }
  async function load(slot: string): Promise<TransferSave | null> {
    let record: SaveRecord;
    try {
      record = await saves.load(slot);
    } catch (e) {
      if (e instanceof ApiError && e.code === "SAVE_NOT_FOUND") return null;
      throw e;
    }
    if (record.sizeBytes > MAX_FILE)
      throw new AccountError(
        "TRANSFER_TOO_LARGE",
        "Save exceeds the 64 MiB transfer limit. Source data is unchanged.",
      );
    if (record.kind === "binary" && !record.deleted) {
      const result = await saves.loadBinary(slot, {maxBytes:MAX_FILE, expectedRevision:record.revision});
      if (result.save.revision !== record.revision)
        throw new AccountError(
          "SNAPSHOT_CHANGED",
          "Save changed during snapshot. Retry preparation.",
        );
      return snapshot(result.save, result.data);
    }
    return snapshot(record);
  }
  const locks = new Map<string, Promise<SwitchResult>>();
  const api: AccountSaves = {
    async prepareAccountSwitch(options = {}) {
      const user = await verifiedAccount(client);
      if (!user.is_anonymous)
        throw new AccountError(
          "GUEST_REQUIRED",
          "Prepare guest progress while authenticated as that guest.",
        );
      const local = structuredClone([
        ...(options.local ?? []),
        ...((await options.beforeSnapshot?.()) ?? []),
      ]);
      for (const v of local) size(v);
      if (new Set(local.map((v) => v.slot)).size !== local.length)
        throw invalid();
      const records = await saves.list();
      // Check declared sizes before fetching any large object. No silent binary omission.
      if (
        records.some((r) => r.sizeBytes > MAX_FILE) ||
        records.reduce((n, r) => n + r.sizeBytes, 0) > MAX_TOTAL
      )
        throw new AccountError(
          "TRANSFER_TOO_LARGE",
          "Cloud saves exceed the bounded transfer budget; export or reduce them before sign-in.",
        );
      const slots: SwitchSlot[] = [];
      for (const slot of new Set([
        ...records.map((r) => r.slot),
        ...local.map((v) => v.slot),
      ])) {
        const guest = local.find((v) => v.slot === slot) ?? (await load(slot));
        slots.push({ slot, guest, cloud: null });
        validate(slots);
        await current(user.id);
      }
      const j: Journal = {
        version: 1,
        id: operationId(),
        sourcePlayerId: user.id,
        phase: "prepared",
        slots,
      };
      await persist(j);
      await current(user.id);
      await store.update(key("pending"), () => ({
        id: j.id,
        sourcePlayerId: j.sourcePlayerId,
      }));
      return { id: j.id, sourcePlayerId: j.sourcePlayerId };
    },
    async pendingAccountSwitch() {
      return (await store.read(key("pending"))) as AccountTransition | null;
    },
    async inspectAccountSwitch(t, { flowId, restart }) {
      const j = await read(t),
        user = await verifiedAccount(client);
      const flow = (await store.read(key("flow", flowId))) as AuthFlow | null;
      if (
        !flow ||
        flow.operation !== "signIn" ||
        flow.sourcePlayerId !== j.sourcePlayerId ||
        flow.targetPlayerId !== user.id ||
        flow.transitionId !== j.id ||
        user.is_anonymous ||
        user.id === j.sourcePlayerId ||
        (j.targetPlayerId && j.targetPlayerId !== user.id)
      )
        throw new AccountError(
          "TRANSITION_MISMATCH",
          "Complete the explicit sign-in associated with this guest transition before inspecting target saves.",
        );
      if (restart && locks.has(t.id))
        throw new AccountError(
          "RESOLUTION_STARTED",
          "Wait for this transfer attempt to settle before reviewing again.",
        );
      if (j.phase === "prepared" || j.phase === "review" || restart) {
        if ((j.previousReviews?.length ?? 0) >= 8)
          throw new AccountError(
            "BACKUP_LIMIT",
            "Export recovery copies before preparing another review; existing backups are retained.",
          );
        const slots: SwitchSlot[] = [];
        for (const s of j.slots) {
          const cloud = await load(s.slot);
          const deleted = j.conflicts?.[s.slot];
          slots.push({
            ...s,
            cloud: cloud ?? (deleted?.deleted ? snapshot(deleted) : null),
          });
          validate(slots);
          await current(user.id);
        }
        const generation = j.generation ?? 0;
        const next: Journal = {
          version: 1,
          id: j.id,
          sourcePlayerId: j.sourcePlayerId,
          slots,
          targetPlayerId: user.id,
          phase: "review",
          generation: generation + 1,
          previousReviews: [
            ...(j.previousReviews ?? []),
            ...(restart ? [structuredClone(j.slots)] : []),
          ],
        };
        await store.update(key("transition", t.id), (old) => {
          const p = old as Journal;
          if ((p.generation ?? 0) !== generation || p.strategy !== j.strategy)
            throw new AccountError(
              "SNAPSHOT_CHANGED",
              "Another tab changed the transition. Review again.",
            );
          return next;
        });
        Object.assign(j, next);
        delete j.strategy;
        delete j.writes;
      }
      return { targetPlayerId: user.id, slots: structuredClone(j.slots) };
    },
    resolveAccountSwitch(t, options) {
      if (locks.has(t.id)) return locks.get(t.id)!;
      const work = (async (): Promise<SwitchResult> => {
        let j = await read(t);
        await current(options.targetPlayerId);
        if (
          j.targetPlayerId !== options.targetPlayerId ||
          j.phase === "prepared"
        )
          throw new AccountError(
            "TRANSITION_MISMATCH",
            "Inspect the authenticated target account before choosing a resolution.",
          );
        if (
          !options.confirmed ||
          (options.backupExisting as boolean | undefined) === false
        )
          throw new AccountError(
            "CONSENT_REQUIRED",
            "Explicit consent and recoverable backups are required.",
          );
        if (
          !["keepCloud", "keepGuest", "merge", "cancel"].includes(
            options.strategy,
          )
        )
          throw invalid();
        if (j.strategy && j.strategy !== options.strategy)
          throw new AccountError(
            "RESOLUTION_STARTED",
            "Resume the already selected resolution; its journal and backups are preserved.",
          );
        if (options.strategy === "cancel")
          return {
            status: "cancelled",
            strategy: "cancel",
            targetPlayerId: options.targetPlayerId,
            completedSlots: [],
          };
        if (!j.strategy) {
          const writes: Write[] = [];
          if (options.strategy !== "keepCloud")
            for (const s of j.slots) {
              let value = s.guest;
              if (options.strategy === "merge") {
                if (!options.merge)
                  throw new AccountError(
                    "MERGE_REQUIRED",
                    "Supply a game-specific merge callback.",
                  );
                value = await options.merge(structuredClone(s));
              }
              if (!value) continue;
              if (value.slot !== s.slot) throw invalid();
              size(value);
              writes.push({
                value: structuredClone(value),
                operationId: operationId(),
                expectedRevision: s.cloud?.revision ?? 0,
              });
            }
          validate(
            writes.map((w) => ({
              slot: w.value.slot,
              guest: w.value,
              cloud: null,
            })),
          );
          await current(options.targetPlayerId);
          // Atomic journal claim serializes cross-tab decisions. A losing tab uses the winner's payload/IDs.
          j = (await store.update(key("transition", t.id), (old) => {
            const previous = old as Journal;
            if (previous.strategy) return previous;
            if ((previous.generation ?? 0) !== (j.generation ?? 0))
              throw new AccountError(
                "SNAPSHOT_CHANGED",
                "Review changed in another tab. Inspect again.",
              );
            if (JSON.stringify(previous.slots) !== JSON.stringify(j.slots))
              throw new AccountError(
                "SNAPSHOT_CHANGED",
                "Review changed in another tab. Inspect again.",
              );
            return {
              ...j,
              strategy: options.strategy,
              writes,
              phase: "importing",
            };
          })) as Journal;
          if (j.strategy !== options.strategy)
            throw new AccountError(
              "RESOLUTION_STARTED",
              "Another tab selected a resolution. Resume that choice.",
            );
        }
        for (const w of j.writes ?? []) {
          if (w.done) continue;
          await current(options.targetPlayerId);
          size(w.value);
          const settings: SaveOptions = {
            expectedPlayerId: options.targetPlayerId,
            expectedRevision: w.expectedRevision,
            operationId: w.operationId,
            ...(w.value.schemaVersion
              ? { schemaVersion: w.value.schemaVersion }
              : {}),
            ...(w.value.metadata ? { metadata: w.value.metadata } : {}),
          };
          try {
            if (
              w.value.kind === "delete" &&
              (!j.slots.find((s) => s.slot === w.value.slot)?.cloud ||
                j.slots.find((s) => s.slot === w.value.slot)?.cloud?.kind ===
                  "delete")
            ) {
              /* Already absent: no mutation needed. */
            } else if (w.value.kind === "delete")
              await saves.delete(w.value.slot, settings);
            else if (w.value.kind === "binary")
              await saves.saveBinary(w.value.slot, w.value.binary!, settings);
            else await saves.save(w.value.slot, w.value.data, settings);
          } catch (error) {
            if (error instanceof SaveConflictError)
              await store.update(key("transition", t.id), (old) => {
                const p = old as Journal;
                if ((p.generation ?? 0) !== (j.generation ?? 0)) return p;
                return {
                  ...p,
                  conflicts: { ...p.conflicts, [w.value.slot]: error.current },
                };
              });
            throw error;
          }
          await current(options.targetPlayerId);
          w.done = true;
          // Keep receipts monotonic across retries/tabs rather than clobber another acknowledgement.
          j = (await store.update(key("transition", t.id), (old) => {
            const p = old as Journal;
            if ((p.generation ?? 0) !== (j.generation ?? 0))
              throw new AccountError(
                "SNAPSHOT_CHANGED",
                "Transition was reviewed in another tab. Inspect before continuing.",
              );
            return {
              ...p,
              writes: p.writes!.map((v) =>
                v.operationId === w.operationId ? { ...v, done: true } : v,
              ),
            };
          })) as Journal;
        }
        j = (await store.update(key("transition", t.id), (old) => {
          const p = old as Journal;
          if ((p.generation ?? 0) !== (j.generation ?? 0))
            throw new AccountError(
              "SNAPSHOT_CHANGED",
              "Transition was reviewed in another tab.",
            );
          return { ...p, phase: "complete" };
        })) as Journal;
        return {
          status: "complete",
          strategy: options.strategy,
          targetPlayerId: options.targetPlayerId,
          completedSlots: (j.writes ?? [])
            .filter((w) => w.done)
            .map((w) => w.value.slot),
        };
      })();
      locks.set(t.id, work);
      void work.finally(() => locks.delete(t.id)).catch(() => {});
      return work;
    },
    async getAccountSwitchRecovery(t) {
      const j = await read(t),
        u = await verifiedAccount(client);
      if (u.id !== j.sourcePlayerId && u.id !== j.targetPlayerId)
        throw new AccountError(
          "TRANSITION_MISMATCH",
          "Sign in as the source or target to recover this snapshot.",
        );
      return {
        targetPlayerId: j.targetPlayerId ?? j.sourcePlayerId,
        slots: structuredClone(j.slots).map((s) =>
          u.id === j.sourcePlayerId ? { ...s, cloud: null } : s,
        ),
        ...(u.id === j.targetPlayerId
          ? { previousReviews: structuredClone(j.previousReviews ?? []) }
          : {}),
      };
    },
    async discardAccountSwitch(t, options) {
      const j = await read(t);
      await current(j.targetPlayerId ?? j.sourcePlayerId);
      if (j.phase !== "complete" || options.acceptDataLoss !== true)
        throw new AccountError(
          "CONSENT_REQUIRED",
          "Complete the transition and explicitly accept backup loss first.",
        );
      await store.update(key("transition", t.id), () => null);
      await store.update(key("pending"), (old) =>
        (old as AccountTransition | null)?.id === t.id ? null : old,
      );
    },
  };
  return api;
}
