import { expect, it, vi } from "vitest";
import {
  createOfflineSaves,
  type SaveStore,
} from "../../packages/sdk-ts/src/offline-saves.js";
import {
  NetworkError,
  ApiError,
  SaveConflictError,
} from "../../packages/sdk-ts/src/errors.js";
import type { Saves } from "../../packages/sdk-ts/src/saves.js";
const record = {
  slot: "profile",
  revision: 1,
  schemaVersion: 1,
  kind: "json" as const,
  metadata: {},
  sizeBytes: 2,
  deleted: false,
  objectPath: null,
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  data: { coins: 5 },
};
function fixture() {
  const entries = new Map();
  const store: SaveStore = {
    async read(key) {
      return structuredClone(entries.get(key) ?? null);
    },
    async update(key, fn) {
      const next = fn(structuredClone(entries.get(key) ?? null));
      entries.set(key, structuredClone(next));
      return structuredClone(next);
    },
  };
  const saves = {
    load: vi.fn().mockResolvedValue(record),
    save: vi.fn().mockResolvedValue({ ...record, revision: 2 }),
  } as unknown as Saves;
  let player = "one";
  const make = () =>
    createOfflineSaves({
      saves,
      store,
      playerId: async () => player,
      namespace: "project",
    });
  return {
    store,
    saves,
    make,
    setPlayer: (id: string) => {
      player = id;
    },
  };
}
it("persists before network, restores after reload and syncs with original operation ID", async () => {
  const f = fixture(),
    a = f.make();
  await a.load("profile");
  vi.mocked(f.saves.save).mockRejectedValue(new NetworkError());
  await a.stage("profile", { coins: 8 });
  await expect(a.sync("profile")).rejects.toBeInstanceOf(NetworkError);
  const b = f.make();
  expect((await b.local("profile"))?.pending[0]?.data).toEqual({ coins: 8 });
  const id = (await b.local("profile"))!.pending[0]!.options.operationId;
  vi.mocked(f.saves.save).mockResolvedValue({
    ...record,
    revision: 2,
    data: { coins: 8 },
  });
  await b.sync("profile");
  expect(vi.mocked(f.saves.save).mock.calls.at(-1)![2]?.operationId).toBe(id);
  expect((await b.local("profile"))?.pending).toEqual([]);
});
it("preserves conflicting local and remote copies until explicit resolution", async () => {
  const f = fixture(),
    a = f.make();
  await a.load("profile");
  await a.stage("profile", { coins: 8 });
  vi.mocked(f.saves.save).mockRejectedValue(
    new SaveConflictError({ ...record, revision: 3 }),
  );
  await expect(a.sync("profile")).rejects.toMatchObject({
    code: "SAVE_CONFLICT",
  });
  const state = await a.local("profile");
  expect(state?.pending[0]?.data).toEqual({ coins: 8 });
  expect(state?.conflict?.revision).toBe(3);
  await a.resolve("profile", { coins: 13 }, 3);
  expect((await a.local("profile"))?.pending[0]?.options.expectedRevision).toBe(
    3,
  );
});
it("does not confuse permission errors with offline and keeps players isolated", async () => {
  const f = fixture(),
    a = f.make();
  await a.load("profile");
  await a.stage("profile", {});
  vi.mocked(f.saves.save).mockRejectedValue(
    new ApiError(403, "FORBIDDEN", "Denied"),
  );
  await expect(a.sync("profile")).rejects.toMatchObject({ code: "FORBIDDEN" });
  f.setPlayer("two");
  expect(await a.local("profile")).toBeNull();
  f.setPlayer("one");
  expect((await a.local("profile"))?.pending).toHaveLength(1);
});
it("a cloud hydration never erases an already staged local write", async () => {
  const f = fixture(),
    a = f.make();
  await a.stage("profile", { coins: 9 });
  await a.load("profile");
  expect((await a.local("profile"))?.pending[0]?.data).toEqual({ coins: 9 });
});
it("stages binary bytes durably and replays deletion through the same revision queue", async () => {
  const f = fixture(),
    a = f.make();
  f.saves.saveBinary = vi
    .fn()
    .mockResolvedValue({ ...record, kind: "binary", revision: 1 });
  f.saves.delete = vi
    .fn()
    .mockResolvedValue({ ...record, revision: 2, deleted: true });
  await a.stageBinary("profile", new Blob(["rpg"]));
  expect(
    await ((await a.local("profile"))!.pending[0]!.data as Blob).text(),
  ).toBe("rpg");
  await a.sync("profile");
  expect(f.saves.saveBinary).toHaveBeenCalled();
  await a.delete("profile");
  await a.sync("profile");
  expect(f.saves.delete).toHaveBeenCalledWith(
    "profile",
    expect.objectContaining({ expectedRevision: 1, expectedPlayerId: "one" }),
  );
});
