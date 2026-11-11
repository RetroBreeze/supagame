import { it, expect, vi, afterEach } from "vitest";
import { createGameServices } from "../../packages/sdk-ts/src/index.js";
import { fixture, session, userId } from "./fixtures.js";
import type { LocalStore } from "../../packages/sdk-ts/src/offline-saves.js";
export function memory<T>(): LocalStore<T> {
  const rows = new Map<string, T>();
  return {
    async read(k) {
      return structuredClone(rows.get(k) ?? null);
    },
    async update(k, fn) {
      const v = fn(structuredClone(rows.get(k) ?? null));
      rows.set(k, structuredClone(v));
      return v;
    },
  };
}
afterEach(() => vi.restoreAllMocks());
function setup() {
  const f = fixture(),
    store = memory();
  const game = createGameServices({
    supabase: f.supabase,
    accounts: { namespace: "test-project", store },
  });
  vi.spyOn(f.supabase.auth, "linkIdentity").mockResolvedValue({
    data: { provider: "google", url: "https://auth.example/link" },
    error: null,
  } as never);
  vi.spyOn(f.supabase.auth, "signInWithOAuth").mockResolvedValue({
    data: { provider: "google", url: "https://auth.example/login" },
    error: null,
  });
  const exchange = vi
    .spyOn(f.supabase.auth, "exchangeCodeForSession")
    .mockResolvedValue({
      data: { session: session(false), user: session(false).user },
      error: null,
    });
  const permanent = (id = userId) => {
    const s = session(false);
    s.user.id = id;
    s.user.identities = [
      {
        provider: "google",
        id: "identity",
        user_id: id,
        identity_id: "identity",
        created_at: "",
        updated_at: "",
      },
    ];
    f.getSession.mockResolvedValue({ data: { session: s }, error: null });
    f.getUser.mockResolvedValue({ data: { user: s.user }, error: null });
  };
  return { ...f, game, store, exchange, permanent };
}
it("distinguishes linking from sign-in and verifies unchanged identity after callback", async () => {
  const f = setup();
  expect(await f.game.players.getAuthStatus()).toMatchObject({
    userId,
    isAnonymous: true,
  });
  const flow = await f.game.players.linkProvider("google", {
    redirectTo: "http://localhost:5173/",
  });
  expect(f.supabase.auth.signInWithOAuth).not.toHaveBeenCalled();
  f.permanent();
  expect(
    await f.game.players.handleAuthCallback(
      `http://localhost:5173/?sg_flow=${flow.flowId}&code=mock`,
    ),
  ).toMatchObject({ operation: "link", userId });
  await f.game.players.handleAuthCallback(
    `http://localhost:5173/?sg_flow=${flow.flowId}&code=mock`,
  );
  expect(f.exchange).toHaveBeenCalledTimes(1);
});
it("never accepts a changed user as a successful link", async () => {
  const f = setup(),
    flow = await f.game.players.linkProvider("google", {
      redirectTo: "https://game.example/",
    });
  f.permanent("another");
  await expect(
    f.game.players.handleAuthCallback(
      `https://game.example/?sg_flow=${flow.flowId}&code=mock`,
    ),
  ).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
});
it("survives SDK recreation and records explicit existing-account sign-in", async () => {
  const f = setup(),
    flow = await f.game.players.signInWithProvider("google", {
      redirectTo: "https://game.example/",
    });
  f.permanent("target");
  const restored = createGameServices({
    supabase: f.supabase,
    accounts: { namespace: "test-project", store: f.store },
  });
  expect(
    await restored.players.handleAuthCallback(
      `https://game.example/?sg_flow=${flow.flowId}&code=mock`,
    ),
  ).toMatchObject({ operation: "signIn", userId: "target" });
  expect(f.supabase.auth.linkIdentity).not.toHaveBeenCalled();
});
it.each(["access_denied", "identity_already_exists", "provider_disabled"])(
  "sanitizes callback errors: %s",
  async (code) => {
    const f = setup(),
      flow = await f.game.players.linkProvider("google", {
        redirectTo: "https://game.example/",
      });
    await expect(
      f.game.players.handleAuthCallback(
        `https://game.example/?sg_flow=${flow.flowId}&error_code=${code}&error_description=secret-token`,
      ),
    ).rejects.not.toHaveProperty("message", "secret-token");
    expect(f.exchange).not.toHaveBeenCalled();
  },
);
it("rejects absent, wrong and expired flow state", async () => {
  const f = setup();
  await expect(
    f.game.players.handleAuthCallback("https://game.example/?code=mock"),
  ).rejects.toMatchObject({ code: "FLOW_MISSING" });
  const flow = await f.game.players.signInWithProvider("google", {
    redirectTo: "https://game.example/",
  });
  await expect(
    f.game.players.handleAuthCallback(
      "https://game.example/?sg_flow=wrong&code=mock",
    ),
  ).rejects.toMatchObject({ code: "FLOW_MISSING" });
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600000);
  await expect(
    f.game.players.handleAuthCallback(
      `https://game.example/?sg_flow=${flow.flowId}&code=mock`,
    ),
  ).rejects.toMatchObject({ code: "FLOW_EXPIRED" });
});
it("does not report linked until verified user contains provider", async () => {
  const f = setup(),
    flow = await f.game.players.linkProvider("google", {
      redirectTo: "https://game.example/",
    });
  await expect(
    f.game.players.handleAuthCallback(
      `https://game.example/?sg_flow=${flow.flowId}&code=mock`,
    ),
  ).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIED" });
});
it("discards a profile response when the authenticated user changes in flight", async () => {
  const f = setup();
  f.fetcher.mockImplementation(async () => {
    f.permanent("other");
    return Response.json({
      playerId: userId,
      displayName: "Guest",
      createdAt: "2026-11-09T12:00:00Z",
    });
  });
  await expect(f.game.players.getMe()).rejects.toMatchObject({
    kind: "authentication",
  });
});
it("passes Supabase PKCE flow identifiers to the supported code exchange", async () => {
  const f = setup(),
    flow = await f.game.players.signInWithProvider("google", {
      redirectTo: "https://game.example/",
    });
  f.permanent("target");
  await f.game.players.handleAuthCallback(
    `https://game.example/?sg_flow=${flow.flowId}&sb_flow_id=provider-flow&code=mock`,
  );
  expect(f.exchange).toHaveBeenCalledWith("mock", { flowId: "provider-flow" });
});
it("signs out locally without account deletion and restores without anonymous replacement", async () => {
  const f = setup(),
    signOut = vi
      .spyOn(f.supabase.auth, "signOut")
      .mockResolvedValue({ error: null });
  await f.game.players.signOut();
  expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  f.getSession.mockResolvedValue({ data: { session: null }, error: null });
  expect(await f.game.players.restoreSession()).toMatchObject({ userId: null });
  expect(f.signIn).not.toHaveBeenCalled();
});
it("maps provider readiness and identity conflicts without returning raw provider diagnostics", async () => {
  const f = setup();
  vi.mocked(f.supabase.auth.linkIdentity).mockResolvedValue({
    data: { provider: "google", url: null },
    error: { code: "identity_already_exists", message: "sensitive" },
  } as never);
  await expect(
    f.game.players.linkProvider("google", {
      redirectTo: "https://game.example/",
    }),
  ).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
  vi.mocked(f.supabase.auth.signInWithOAuth).mockResolvedValue({
    data: { provider: "google", url: null },
    error: { code: "provider_disabled", message: "sensitive" },
  } as never);
  await expect(
    f.game.players.signInWithProvider("google", {
      redirectTo: "https://game.example/",
    }),
  ).rejects.toMatchObject({ code: "OAUTH_FAILED" });
});
it("offline login fails before creating provider requests", async () => {
  const f = setup();
  vi.stubGlobal("navigator", { onLine: false });
  try {
    await expect(
      f.game.players.signInWithProvider("google", {
        redirectTo: "https://game.example/",
      }),
    ).rejects.toMatchObject({ code: "OFFLINE" });
    expect(f.supabase.auth.signInWithOAuth).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
it("sanitizes malformed callback URLs and recognizes fragment-only provider errors", async () => {
  const f = setup();
  await expect(
    f.game.players.handleAuthCallback("invalid?code=private-code"),
  ).rejects.toMatchObject({ code: "FLOW_MISSING" });
  const flow = await f.game.players.linkProvider("google", {
    redirectTo: "https://game.example/",
  });
  await expect(
    f.game.players.handleAuthCallback(
      `https://game.example/?sg_flow=${flow.flowId}#error_code=identity_already_exists`,
    ),
  ).rejects.toMatchObject({ code: "ACCOUNT_CONFLICT" });
});
it("cancels authentication only before exchange while the original session remains, retaining staged data", async () => {
  const f = setup(),
    flow = await f.game.players.signInWithProvider("google", {
      redirectTo: "https://game.example/",
    });
  await f.store.update(
    JSON.stringify(["test-project", "transition", "guest-copy"]),
    () => ({ data: "unsynced" }),
  );
  expect(await f.game.players.cancelAuthFlow(flow.flowId)).toMatchObject({
    userId,
    isAnonymous: true,
  });
  await expect(
    f.game.players.handleAuthCallback(
      `https://game.example/?sg_flow=${flow.flowId}&code=mock`,
    ),
  ).rejects.toMatchObject({ code: "FLOW_CANCELLED" });
  expect(f.exchange).not.toHaveBeenCalled();
  expect(
    await f.store.read(
      JSON.stringify(["test-project", "transition", "guest-copy"]),
    ),
  ).toEqual({ data: "unsynced" });
  expect(await f.game.players.getAuthStatus()).toMatchObject({
    userId,
    isAnonymous: true,
  });
});
it("cannot pretend to cancel or resurrect guest authentication after Google sign-in", async () => {
  const f = setup(),
    flow = await f.game.players.signInWithProvider("google", {
      redirectTo: "https://game.example/",
    });
  f.permanent("target");
  await expect(
    f.game.players.cancelAuthFlow(flow.flowId),
  ).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
  expect(await f.game.players.getAuthStatus()).toMatchObject({
    userId: "target",
    isAnonymous: false,
  });
});
it("refuses cancellation while an OAuth exchange is in flight", async () => {
  const f = setup(),
    flow = await f.game.players.signInWithProvider("google", {
      redirectTo: "https://game.example/",
    });
  let finish!: () => void;
  f.exchange.mockImplementation(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      data: { session: session(false), user: session(false).user },
      error: null,
    };
  });
  const completion = f.game.players.handleAuthCallback(
    `https://game.example/?sg_flow=${flow.flowId}&code=mock`,
  );
  await vi.waitFor(() => expect(f.exchange).toHaveBeenCalledOnce());
  await expect(
    f.game.players.cancelAuthFlow(flow.flowId),
  ).rejects.toMatchObject({ code: "AUTH_IN_PROGRESS" });
  f.permanent("target");
  finish();
  expect(await completion).toMatchObject({ userId: "target" });
});
