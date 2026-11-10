import { expect, it, vi } from "vitest";
import {
  createGameServices,
  SaveConflictError,
} from "../../packages/sdk-ts/src/index.js";
import type { LocalStore } from "../../packages/sdk-ts/src/offline-saves.js";
import { fixture, session, userId } from "./fixtures.js";
function setup() {
  const f = fixture(),
    rows = new Map<string, unknown>();
  const store: LocalStore<unknown> = {
    async read(k) {
      return structuredClone(rows.get(k) ?? null);
    },
    async update(k, fn) {
      const n = fn(structuredClone(rows.get(k) ?? null));
      rows.set(k, structuredClone(n));
      return n;
    },
  };
  const game = createGameServices({
    supabase: f.supabase,
    accounts: { namespace: "project", store },
  });
  const record = (data: unknown, revision = 1) => ({
    slot: "workshop",
    revision,
    schemaVersion: 1,
    kind: "json" as "json" | "binary",
    metadata: {},
    sizeBytes: 10,
    deleted: false,
    objectPath: null,
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-10T00:00:00Z",
    data,
  });
  let remote = record({ coins: 9 }),
    lost = false;
  const receipts = new Map<string, unknown>();
  vi.spyOn(game.saves, "list").mockImplementation(async () => [remote]);
  vi.spyOn(game.saves, "load").mockImplementation(async () =>
    structuredClone(remote),
  );
  vi.spyOn(game.saves, "save").mockImplementation(
    async (_slot, data, options) => {
      if (receipts.has(options!.operationId!))
        return receipts.get(options!.operationId!) as typeof remote;
      if (options!.expectedRevision !== remote.revision)
        throw new SaveConflictError(remote);
      remote = record(data, remote.revision + 1);
      receipts.set(options!.operationId!, remote);
      if (lost) {
        lost = false;
        throw Error("lost response");
      }
      return remote;
    },
  );
  async function login(id = "target") {
    const s = session(false);
    s.user.id = id;
    s.user.identities = [
      {
        provider: "google",
        id: "google",
        identity_id: "google",
        user_id: id,
        created_at: "",
        updated_at: "",
      },
    ];
    f.getSession.mockResolvedValue({ data: { session: s }, error: null });
    f.getUser.mockResolvedValue({ data: { user: s.user }, error: null });
  }
  async function auth(transition: { id: string }) {
    const flowId = "10000000-0000-4000-8000-000000000001";
    await store.update(JSON.stringify(["project", "flow", flowId]), () => ({
      version: 1,
      id: flowId,
      operation: "signIn",
      sourcePlayerId: userId,
      targetPlayerId: "target",
      transitionId: transition.id,
    }));
    await login();
    remote = record({ coins: 20 }, 4);
    return flowId;
  }
  return {
    game,
    store,
    rows,
    record,
    login,
    auth,
    remote: () => remote,
    setRemote: (r: typeof remote) => {
      remote = r;
    },
    loseResponse: () => {
      lost = true;
    },
  };
}
it("stages unsynchronized guest data durably without credentials", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch({
      local: [{ slot: "workshop", kind: "json", data: { coins: 11 } }],
    });
  expect(t.sourcePlayerId).toBe(userId);
  expect(JSON.stringify([...f.rows.values()])).not.toMatch(
    /test-user-token|refresh_token|access_token/,
  );
  const flowId = await f.auth(t),
    review = await f.game.saves.inspectAccountSwitch(t, { flowId });
  expect(review.slots[0]?.guest?.data).toEqual({ coins: 11 });
  expect(review.slots[0]?.cloud?.data).toEqual({ coins: 20 });
});
it.each(["keepCloud", "cancel"] as const)(
  "%s leaves cloud unchanged and retains guest snapshot",
  async (strategy) => {
    const f = setup(),
      t = await f.game.saves.prepareAccountSwitch(),
      flowId = await f.auth(t);
    await f.game.saves.inspectAccountSwitch(t, { flowId });
    await f.game.saves.resolveAccountSwitch(t, {
      strategy,
      targetPlayerId: "target",
      confirmed: true,
    });
    expect(f.game.saves.save).not.toHaveBeenCalled();
    expect(JSON.stringify([...f.rows.values()])).toContain("coins");
  },
);
it("keepGuest replaces only after consent, preserves backup and retries a lost response", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "keepGuest",
      targetPlayerId: "target",
      confirmed: false,
    }),
  ).rejects.toMatchObject({ code: "CONSENT_REQUIRED" });
  f.loseResponse();
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "keepGuest",
      targetPlayerId: "target",
      confirmed: true,
    }),
  ).rejects.toThrow("lost response");
  expect(f.remote().revision).toBe(5);
  const result = await f.game.saves.resolveAccountSwitch(t, {
    strategy: "keepGuest",
    targetPlayerId: "target",
    confirmed: true,
  });
  expect(result.status).toBe("complete");
  expect(f.remote().revision).toBe(5);
  expect(f.remote().data).toEqual({ coins: 9 });
  const recovery = await f.game.saves.getAccountSwitchRecovery(t);
  expect(recovery.slots[0]?.cloud?.data).toEqual({ coins: 20 });
});
it("custom merge receives both versions and commits once", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  const merge = vi.fn(({ guest }) => ({ ...guest!, data: { coins: 30 } }));
  await f.game.saves.resolveAccountSwitch(t, {
    strategy: "merge",
    targetPlayerId: "target",
    confirmed: true,
    merge,
  });
  expect(merge).toHaveBeenCalledTimes(1);
  expect(f.remote().data).toEqual({ coins: 30 });
});
it("concurrent writes fail without overwriting and preserve both versions", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  f.setRemote(f.record({ coins: 22 }, 5));
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "keepGuest",
      targetPlayerId: "target",
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "SAVE_CONFLICT" });
  expect(f.remote().data).toEqual({ coins: 22 });
});
it("rejects account drift, unbound sign-ins and invalid snapshots", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch();
  await f.login();
  await expect(
    f.game.saves.inspectAccountSwitch(t, { flowId: "unknown" }),
  ).rejects.toMatchObject({ code: "TRANSITION_MISMATCH" });
  const flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  await f.login("other");
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "keepGuest",
      targetPlayerId: "target",
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "TRANSITION_MISMATCH" });
  await expect(
    f.game.saves.prepareAccountSwitch({
      local: [{ slot: "workshop", kind: "json", data: { bad: Infinity } }],
    }),
  ).rejects.toThrow();
});
it("binary transfer uses durable Blobs and saves with revision and stable operation id", async () => {
  const f = setup(),
    blob = new Blob(["guest bytes"]);
  f.setRemote({
    ...f.record(undefined),
    kind: "binary",
    sizeBytes: blob.size,
  } as ReturnType<typeof f.record>);
  vi.spyOn(f.game.saves, "loadBinary").mockResolvedValue({
    save: f.remote(),
    data: blob,
  });
  const write = vi
    .spyOn(f.game.saves, "saveBinary")
    .mockResolvedValue({ ...f.remote(), revision: 5 });
  const t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  await f.game.saves.resolveAccountSwitch(t, {
    strategy: "keepGuest",
    targetPlayerId: "target",
    confirmed: true,
  });
  expect(await write.mock.calls[0]![1].text()).toBe("guest bytes");
  expect(write.mock.calls[0]![2]).toMatchObject({
    expectedRevision: 4,
    expectedPlayerId: "target",
  });
});
it("oversized binary blocks before downloading or switching sessions", async () => {
  const f = setup();
  f.setRemote({
    ...f.record(undefined),
    kind: "binary",
    sizeBytes: 200000000,
  } as ReturnType<typeof f.record>);
  const load = vi.spyOn(f.game.saves, "loadBinary");
  await expect(f.game.saves.prepareAccountSwitch()).rejects.toMatchObject({
    code: "TRANSFER_TOO_LARGE",
  });
  expect(load).not.toHaveBeenCalled();
});
it("durable storage failure never permits replacement", async () => {
  const f = setup();
  vi.spyOn(f.store, "update").mockRejectedValue(Error("storage full"));
  await expect(f.game.saves.prepareAccountSwitch()).rejects.toThrow(
    "storage full",
  );
  expect(f.game.saves.save).not.toHaveBeenCalled();
});
it("retains both binary versions after SDK recreation", async () => {
  const f = setup(),
    guestBlob = new Blob(["guest"]),
    cloudBlob = new Blob(["cloud"]);
  f.setRemote({ ...f.record(undefined), kind: "binary", sizeBytes: 5 });
  vi.spyOn(f.game.saves, "loadBinary").mockResolvedValue({
    save: f.remote(),
    data: guestBlob,
  });
  const t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  f.setRemote({ ...f.record(undefined, 4), kind: "binary", sizeBytes: 5 });
  vi.mocked(f.game.saves.loadBinary).mockResolvedValue({
    save: f.remote(),
    data: cloudBlob,
  });
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  const recovery = await f.game.saves.getAccountSwitchRecovery(t);
  expect(await recovery.slots[0]!.guest!.binary!.text()).toBe("guest");
  expect(await recovery.slots[0]!.cloud!.binary!.text()).toBe("cloud");
});
it("competing resolutions cannot overwrite the first selected strategy", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  await f.game.saves.resolveAccountSwitch(t, {
    strategy: "keepCloud",
    targetPlayerId: "target",
    confirmed: true,
  });
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "keepGuest",
      targetPlayerId: "target",
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "RESOLUTION_STARTED" });
  expect(f.remote().data).toEqual({ coins: 20 });
});
it("invalid custom merge writes nothing and retains backup", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "merge",
      targetPlayerId: "target",
      confirmed: true,
      merge: () => ({ slot: "workshop", kind: "json", data: { n: NaN } }),
    }),
  ).rejects.toThrow();
  expect(f.game.saves.save).not.toHaveBeenCalled();
  expect(
    (await f.game.saves.getAccountSwitchRecovery(t)).slots[0]?.cloud?.data,
  ).toEqual({ coins: 20 });
});
it("source account recovery never returns the target account backup", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  await f.login(userId);
  expect(
    (await f.game.saves.getAccountSwitchRecovery(t)).slots[0]?.cloud,
  ).toBeNull();
});
it("rejects oversized metadata before making a transition durable", async () => {
  const f = setup();
  await expect(
    f.game.saves.prepareAccountSwitch({
      local: [
        {
          slot: "workshop",
          kind: "json",
          data: {},
          metadata: { huge: "x".repeat(5000) },
        },
      ],
    }),
  ).rejects.toMatchObject({ code: "INVALID_SNAPSHOT" });
  expect(f.rows.size).toBe(0);
});
it("explicitly re-reviews newer revisions after a conflict while retaining older backups", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch(),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  f.setRemote(f.record({ coins: 22 }, 5));
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "keepGuest",
      targetPlayerId: "target",
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "SAVE_CONFLICT" });
  const review = await f.game.saves.inspectAccountSwitch(t, {
    flowId,
    restart: true,
  });
  expect(review.slots[0]?.cloud?.revision).toBe(5);
  await f.game.saves.resolveAccountSwitch(t, {
    strategy: "keepGuest",
    targetPlayerId: "target",
    confirmed: true,
  });
  expect(f.remote().data).toEqual({ coins: 9 });
  expect(
    (await f.game.saves.getAccountSwitchRecovery(t)).previousReviews?.[0]?.[0]
      ?.cloud?.data,
  ).toEqual({ coins: 20 });
});
it("treats a concurrently deleted target as absent after explicit re-review", async () => {
  const f = setup(),
    t = await f.game.saves.prepareAccountSwitch({
      local: [{ slot: "workshop", kind: "delete" }],
    }),
    flowId = await f.auth(t);
  await f.game.saves.inspectAccountSwitch(t, { flowId });
  const remove = vi
    .spyOn(f.game.saves, "delete")
    .mockRejectedValue(
      new SaveConflictError({ ...f.record(null, 5), deleted: true }),
    );
  await expect(
    f.game.saves.resolveAccountSwitch(t, {
      strategy: "keepGuest",
      targetPlayerId: "target",
      confirmed: true,
    }),
  ).rejects.toMatchObject({ code: "SAVE_CONFLICT" });
  const { ApiError } = await import("../../packages/sdk-ts/src/errors.js");
  vi.mocked(f.game.saves.load).mockRejectedValue(
    new ApiError(404, "SAVE_NOT_FOUND", "Missing"),
  );
  await f.game.saves.inspectAccountSwitch(t, { flowId, restart: true });
  await f.game.saves.resolveAccountSwitch(t, {
    strategy: "keepGuest",
    targetPlayerId: "target",
    confirmed: true,
  });
  expect(remove).toHaveBeenCalledTimes(1);
});
