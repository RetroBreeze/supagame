import { afterEach, expect, it, vi } from "vitest";
import { createGameServices } from "../../packages/sdk-ts/src/index.js";
import { fixture, session } from "./fixtures.js";
const record = {
  slot: "profile",
  revision: 1,
  schemaVersion: 1,
  kind: "json",
  metadata: {},
  sizeBytes: 2,
  deleted: false,
  objectPath: null,
  createdAt: "2026-11-10T00:00:00Z",
  updatedAt: "2026-11-10T00:00:00Z",
  data: { coins: 4 },
};
afterEach(() => vi.restoreAllMocks());
it("saves JSON with explicit revisions and stable retry keys; loads, lists and deletes", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(Response.json({ save: record }));
  const saves = createGameServices({ supabase: f.supabase }).saves;
  const saved = await saves.save(
    "profile",
    { coins: 4 },
    { operationId: "10000000-0000-4000-8000-000000000001" },
  );
  expect(saved.revision).toBe(1);
  expect(JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string)).toMatchObject(
    { action: "save", expectedRevision: 0, schemaVersion: 1 },
  );
  f.fetcher.mockImplementation(async () => Response.json({ save: record }));
  expect((await saves.load("profile")).data).toEqual({ coins: 4 });
  await saves.save("profile", { coins: 5 });
  expect(
    JSON.parse(f.fetcher.mock.calls.at(-1)![1]!.body as string)
      .expectedRevision,
  ).toBe(1);
  f.fetcher.mockImplementation(async () => Response.json({ slots: [record] }));
  expect(await saves.list()).toHaveLength(1);
  f.fetcher.mockImplementation(async () =>
    Response.json({ save: { ...record, revision: 2, deleted: true } }),
  );
  expect((await saves.delete("profile")).deleted).toBe(true);
});
it("returns conflict including current state without replacing the attempted state", async () => {
  const f = fixture();
  f.fetcher.mockResolvedValue(
    Response.json(
      { code: "SAVE_CONFLICT", message: "Changed", current: record },
      { status: 409 },
    ),
  );
  await expect(
    createGameServices({ supabase: f.supabase }).saves.save("profile", {
      coins: 9,
    }),
  ).rejects.toMatchObject({ code: "SAVE_CONFLICT", current: record });
});
it("rejects invalid JSON instead of silently dropping values and isolates cached revisions by player", async () => {
  const f = fixture();
  const saves = createGameServices({ supabase: f.supabase }).saves;
  await expect(saves.save("profile", { x: undefined })).rejects.toMatchObject({
    kind: "invalid_parameter",
  });
  await expect(saves.save("profile", { x: Infinity })).rejects.toMatchObject({
    kind: "invalid_parameter",
  });
  f.fetcher.mockImplementation(async () => Response.json({ save: record }));
  await saves.load("profile");
  const other = session();
  other.user = { ...other.user, id: "00000000-0000-4000-8000-000000000002" };
  f.getSession.mockResolvedValue({ data: { session: other }, error: null });
  await saves.save("profile", {});
  expect(
    JSON.parse(f.fetcher.mock.calls.at(-1)![1]!.body as string)
      .expectedRevision,
  ).toBe(0);
});
it("pins queued writes to their original player even if Auth changes before dispatch", async () => {
  const f = fixture();
  await expect(
    createGameServices({ supabase: f.supabase }).saves.save(
      "profile",
      { coins: 9 },
      { expectedPlayerId: "different-player" },
    ),
  ).rejects.toMatchObject({ kind: "authentication" });
  expect(f.fetcher).not.toHaveBeenCalled();
});
