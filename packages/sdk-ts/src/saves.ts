import type {
  SaveRecord,
  SaveResult,
  SaveList,
  SaveUpload,
  SaveObjects,
} from "@supagame/contracts";
import type { Session } from "@supabase/supabase-js";
import { requireSession, type SupabaseConnection } from "./auth.js";
import { matches, type Transport } from "./client.js";
import {
  AuthenticationError,
  GameServicesError,
  InvalidParameterError,
  StorageError,
} from "./errors.js";
import { operationId, validateJson, type JsonValue } from "./save-values.js";

export interface SaveOptions {
  expectedPlayerId?: string;
  expectedRevision?: number;
  operationId?: string;
  schemaVersion?: number;
  metadata?: Record<string, JsonValue>;
}
export type Saved<T = unknown> = Omit<SaveRecord, "data"> & { data?: T };
export interface Saves {
  save<T>(slot: string, data: T, options?: SaveOptions): Promise<Saved<T>>;
  load<T = unknown>(slot: string): Promise<Saved<T>>;
  list(): Promise<SaveRecord[]>;
  delete(
    slot: string,
    options?: Pick<
      SaveOptions,
      "expectedRevision" | "operationId" | "expectedPlayerId"
    >,
  ): Promise<SaveRecord>;
  saveBinary(
    slot: string,
    data: Blob,
    options?: SaveOptions,
  ): Promise<SaveRecord>;
  loadBinary(slot: string): Promise<{ save: SaveRecord; data: Blob }>;
  abortBinary(slot: string, operationId: string): Promise<void>;
  cleanup(): Promise<number>;
}
function slotPath(slot: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(slot) || slot === "cleanup")
    throw new InvalidParameterError(
      "slot",
      "Use 1–64 letters, digits, underscores or hyphens; cleanup is reserved.",
    );
  return `/saves/${slot}`;
}
export function createSaves(
  client: SupabaseConnection,
  transport: Transport,
): Saves {
  const revisions = new Map<string, number>();
  const key = (session: Session, slot: string) => `${session.user.id}:${slot}`;
  async function same(session: Session) {
    if ((await requireSession(client)).user.id !== session.user.id)
      throw new AuthenticationError(
        "The player changed during the save operation.",
      );
  }
  const storage = () => {
    if (!client.storage) throw new StorageError();
    return client.storage.from("supagame-saves");
  };
  function storageFailure(error: {
    statusCode?: string | number | undefined;
    name?: string;
  }): never {
    const status = Number(error.statusCode);
    if (status === 401) throw new AuthenticationError();
    throw new StorageError(
      status === 403
        ? "FORBIDDEN"
        : status === 413
          ? "SAVE_QUOTA_EXCEEDED"
          : "STORAGE_UNAVAILABLE",
      status === 403 ? 403 : status === 413 ? 413 : 503,
    );
  }
  async function mutate(
    slot: string,
    action: "save" | "delete" | "prepare",
    session: Session,
    options: SaveOptions,
    data?: unknown,
    sizeBytes?: number,
  ) {
    if (
      options.expectedPlayerId !== undefined &&
      options.expectedPlayerId !== session.user.id
    )
      throw new AuthenticationError("The save belongs to another player.");
    const id = options.operationId ?? operationId();
    const body = {
      action,
      expectedRevision:
        options.expectedRevision ?? revisions.get(key(session, slot)) ?? 0,
      operationId: id,
      ...(action !== "delete"
        ? {
            schemaVersion: options.schemaVersion ?? 1,
            metadata: options.metadata ?? {},
            ...(action === "save" ? { data } : { sizeBytes }),
          }
        : {}),
    };
    if (!matches("SaveMutation", body))
      throw new InvalidParameterError(
        "save",
        "Invalid save options or operation ID.",
      );
    validateJson(body);
    try {
      const result = await transport.request<SaveResult | SaveUpload>(
        slotPath(slot),
        "POST",
        action === "prepare" ? "SaveUpload" : "SaveResult",
        { session, body },
      );
      await same(session);
      if ("save" in result)
        revisions.set(key(session, slot), result.save.revision);
      return result;
    } catch (error) {
      if (error instanceof GameServicesError) error.operationId = id;
      throw error;
    }
  }
  const api: Saves = {
    async save(slot, data, options = {}) {
      validateJson(data);
      const session = await requireSession(client);
      const result = (await mutate(
        slot,
        "save",
        session,
        options,
        data,
      )) as SaveResult;
      return { ...result.save, data };
    },
    async load<T>(slot: string) {
      const session = await requireSession(client);
      const result = await transport.request<SaveResult>(
        slotPath(slot),
        "GET",
        "SaveResult",
        { session },
      );
      await same(session);
      revisions.set(key(session, slot), result.save.revision);
      return result.save as Saved<T>;
    },
    async list() {
      const session = await requireSession(client);
      const result = await transport.request<SaveList>(
        "/saves",
        "GET",
        "SaveList",
        { session },
      );
      await same(session);
      return result.slots;
    },
    async delete(slot, options = {}) {
      const session = await requireSession(client);
      return ((await mutate(slot, "delete", session, options)) as SaveResult)
        .save;
    },
    async saveBinary(slot, data, options = {}) {
      if (!(data instanceof Blob) || data.size < 1)
        throw new InvalidParameterError(
          "data",
          "Binary saves require a nonempty Blob.",
        );
      if (!globalThis.crypto?.subtle)
        throw new InvalidParameterError(
          "data",
          "Binary content hashing requires HTTPS or localhost.",
        );
      const session = await requireSession(client);
      const id = options.operationId ?? operationId();
      if (
        options.expectedPlayerId !== undefined &&
        options.expectedPlayerId !== session.user.id
      )
        throw new AuthenticationError("The save belongs to another player.");
      try {
        // On a lost commit response, prepare may return its receipt. Request it
        // with the union-compatible path below rather than allocating another object.
        const payload = {
          action: "prepare",
          expectedRevision:
            options.expectedRevision ?? revisions.get(key(session, slot)) ?? 0,
          operationId: id,
          schemaVersion: options.schemaVersion ?? 1,
          metadata: options.metadata ?? {},
          sizeBytes: data.size,
          checksum: Array.from(
            new Uint8Array(
              await crypto.subtle.digest("SHA-256", await data.arrayBuffer()),
            ),
            (b) => b.toString(16).padStart(2, "0"),
          ).join(""),
        };
        if (!matches("SaveMutation", payload))
          throw new InvalidParameterError(
            "save",
            "Invalid binary save options.",
          );
        validateJson(payload);
        const prepared = await transport.request<SaveUpload | SaveResult>(
          slotPath(slot),
          "POST",
          "SavePreparation",
          { session, body: payload },
        );
        await same(session);
        if ("save" in prepared) {
          revisions.set(key(session, slot), prepared.save.revision);
          return prepared.save;
        }
        const path = prepared.upload.path;
        if (
          prepared.upload.bucket !== "supagame-saves" ||
          path !== `${session.user.id}/${id}`
        )
          throw new StorageError();
        const upload = await storage().upload(path, await data.arrayBuffer(), {
          upsert: false,
          contentType: "application/octet-stream",
        });
        // Duplicate object after a lost upload response is safe: it is immutable
        // and commit checks the reservation's exact size. No overwrite is used.
        if (
          upload.error &&
          !["409", "400"].includes(String(upload.error.statusCode))
        )
          storageFailure(upload.error);
        if (
          upload.error &&
          String(upload.error.statusCode) === "400" &&
          !["Duplicate", "Asset Already Exists"].includes(upload.error.message)
        )
          storageFailure(upload.error);
        await same(session);
        const result = await transport.request<SaveResult>(
          slotPath(slot),
          "POST",
          "SaveResult",
          { session, body: { action: "commit", operationId: id } },
        );
        await same(session);
        revisions.set(key(session, slot), result.save.revision);
        return result.save;
      } catch (error) {
        if (error instanceof GameServicesError) error.operationId = id;
        throw error;
      }
    },
    async loadBinary(slot) {
      const session = await requireSession(client);
      const save = await api.load(slot);
      if (
        save.kind !== "binary" ||
        !save.objectPath ||
        !save.objectPath.startsWith(`${session.user.id}/`)
      )
        throw new InvalidParameterError("slot", "This is not a binary save.");
      await same(session);
      const result = await storage().download(save.objectPath);
      if (result.error) storageFailure(result.error);
      await same(session);
      return { save, data: result.data! };
    },
    async abortBinary(slot, id) {
      const session = await requireSession(client);
      await transport.request(slotPath(slot), "POST", "SaveObjects", {
        session,
        body: { action: "abort", operationId: id },
      });
      await same(session);
      await api.cleanup();
    },
    async cleanup() {
      const session = await requireSession(client);
      const result = await transport.request<SaveObjects>(
        "/saves/cleanup",
        "POST",
        "SaveObjects",
        { session },
      );
      await same(session);
      if (
        result.objects.some((path) => !path.startsWith(`${session.user.id}/`))
      )
        throw new StorageError();
      if (result.objects.length) {
        const removed = await storage().remove(result.objects);
        if (removed.error) storageFailure(removed.error);
        await same(session);
      }
      return result.objects.length;
    },
  };
  return api;
}
