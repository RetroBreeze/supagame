import type { AuthChangeEvent, Provider, User } from "@supabase/supabase-js";
import {
  readSession,
  requireSession,
  type SupabaseConnection,
} from "./auth.js";
import { createIndexedDbStore } from "./indexeddb.js";
import type { LocalStore } from "./offline-saves.js";
import { GameServicesError } from "./errors.js";
import { operationId } from "./save-values.js";

export class AccountError extends GameServicesError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super("authentication", message);
  }
}
export interface AccountOptions {
  namespace: string;
  store?: LocalStore<unknown>;
}
export interface AccountStatus {
  userId: string | null;
  isAnonymous: boolean;
  providers: string[];
}
export interface AuthFlow {
  version: 1;
  id: string;
  operation: "link" | "signIn";
  provider: Provider;
  sourcePlayerId: string | null;
  redirectTo: string;
  expiresAt: number;
  transitionId?: string;
  exchanging?: boolean;
  cancelled?: boolean;
  targetPlayerId?: string;
}
export interface ProviderOptions {
  redirectTo: string;
  transitionId?: string;
}
export interface AccountCallback {
  flowId: string;
  operation: "link" | "signIn";
  userId: string;
  transitionId?: string;
}
export interface AccountPlayers {
  getAuthStatus(): Promise<AccountStatus>;
  restoreSession(): Promise<AccountStatus>;
  linkProvider(
    provider: Provider,
    options: ProviderOptions,
  ): Promise<{ url: string; flowId: string }>;
  signInWithProvider(
    provider: Provider,
    options: ProviderOptions,
  ): Promise<{ url: string; flowId: string }>;
  handleAuthCallback(url: string): Promise<AccountCallback>;
  /** Stops an unexchanged flow only while its source account is still authenticated. Never restores credentials. */
  cancelAuthFlow(flowId: string): Promise<AccountStatus>;
  signOut(): Promise<void>;
  onAuthStateChange(
    callback: (status: AccountStatus, event: AuthChangeEvent) => void,
  ): { unsubscribe(): void };
}
export function accountContext(options?: AccountOptions) {
  const store =
    options?.store ??
    createIndexedDbStore<unknown>("supagame-account-transitions-v1");
  const key = (type: string, id = "") => {
    if (!options?.namespace || options.namespace.length > 512)
      throw new AccountError(
        "STORAGE_REQUIRED",
        "Configure accounts.namespace with a stable project and game identifier.",
      );
    return JSON.stringify([options.namespace, type, id]);
  };
  return { store, key };
}
export type AccountContext = ReturnType<typeof accountContext>;
function status(user: User | null): AccountStatus {
  return {
    userId: user?.id ?? null,
    isAnonymous: user?.is_anonymous === true,
    providers: [...new Set(user?.identities?.map((i) => i.provider) ?? [])],
  };
}
function failure(code?: string): AccountError {
  if (
    [
      "identity_already_exists",
      "identity_already_linked",
      "email_exists",
    ].includes(code ?? "")
  )
    return new AccountError(
      "ACCOUNT_CONFLICT",
      "This identity belongs to an account. Choose Sign In explicitly to recover it; no saves were merged.",
    );
  if (code === "access_denied")
    return new AccountError(
      "OAUTH_CANCELLED",
      "Provider sign-in was cancelled. Your staged saves are preserved.",
    );
  return new AccountError(
    "OAUTH_FAILED",
    "Authentication failed. Check provider configuration, redirect URLs and connectivity, then start a new flow. Staged saves are preserved.",
  );
}
export async function verifiedAccount(client: SupabaseConnection) {
  const session = await requireSession(client);
  const result = await client.auth.getUser(session.access_token).catch(() => {
    throw failure();
  });
  if (result.error || result.data.user?.id !== session.user.id)
    throw new AccountError(
      "IDENTITY_UNVERIFIED",
      "The authenticated identity could not be verified.",
    );
  return result.data.user;
}
export function createAccountPlayers(
  client: SupabaseConnection,
  context: AccountContext,
): AccountPlayers {
  const { store, key } = context;
  async function getAuthStatus() {
    if (!(await readSession(client))) return status(null);
    return status(await verifiedAccount(client));
  }
  async function begin(
    operation: AuthFlow["operation"],
    provider: Provider,
    options: ProviderOptions,
  ) {
    if (typeof navigator !== "undefined" && navigator.onLine === false)
      throw new AccountError(
        "OFFLINE",
        "Reconnect before starting provider authentication. Your saves remain on this device.",
      );
    let redirect: URL;
    try {
      redirect = new URL(options.redirectTo);
    } catch {
      throw failure();
    }
    if (
      (redirect.protocol !== "https:" &&
        !(
          redirect.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)
        )) ||
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search
    )
      throw new AccountError(
        "INVALID_REDIRECT",
        "Use an HTTPS callback URL (HTTP only on localhost), without query, fragment or credentials.",
      );
    const current = await getAuthStatus();
    if (operation === "link" && !current.userId)
      throw new AccountError(
        "SESSION_REQUIRED",
        "Restore your guest session before linking.",
      );
    const flow: AuthFlow = {
      version: 1,
      id: operationId(),
      operation,
      provider,
      sourcePlayerId: current.userId,
      redirectTo: redirect.href,
      expiresAt: Date.now() + 15 * 60 * 1000,
      ...(options.transitionId ? { transitionId: options.transitionId } : {}),
    };
    if (options.transitionId) {
      const transition = (await store.read(
        key("transition", options.transitionId),
      )) as { sourcePlayerId?: string; phase?: string } | null;
      if (
        operation !== "signIn" ||
        transition?.sourcePlayerId !== current.userId ||
        transition?.phase !== "prepared"
      )
        throw new AccountError(
          "TRANSITION_MISMATCH",
          "Prepare a save transition for the current guest before sign-in.",
        );
    }
    await store.update(key("flow", flow.id), () => flow);
    redirect.searchParams.set("sg_flow", flow.id);
    const input = {
      provider,
      options: { redirectTo: redirect.href, skipBrowserRedirect: true },
    };
    const result = await (
      operation === "link"
        ? client.auth.linkIdentity(input)
        : client.auth.signInWithOAuth(input)
    ).catch(() => {
      throw failure();
    });
    if (result.error || !result.data.url) throw failure(result.error?.code);
    return { url: result.data.url, flowId: flow.id };
  }
  let callback: Promise<AccountCallback> | undefined;
  async function complete(url: string): Promise<AccountCallback> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AccountError(
        "FLOW_MISSING",
        "The callback URL is invalid. Start authentication again.",
      );
    }
    const id = parsed.searchParams.get("sg_flow");
    const flow = id
      ? ((await store.read(key("flow", id))) as AuthFlow | null)
      : null;
    if (!flow || flow.version !== 1 || flow.id !== id)
      throw new AccountError(
        "FLOW_MISSING",
        "No matching authentication flow exists on this device. Start sign-in again.",
      );
    if (flow.cancelled)
      throw new AccountError(
        "FLOW_CANCELLED",
        "Authentication was stopped before exchange. Staged saves are retained.",
      );
    if (flow.expiresAt < Date.now())
      throw new AccountError(
        "FLOW_EXPIRED",
        "Authentication flow expired. Start again; staged saves are retained.",
      );
    const expected = new URL(flow.redirectTo);
    if (
      parsed.origin !== expected.origin ||
      parsed.pathname !== expected.pathname
    )
      throw new AccountError(
        "FLOW_MISSING",
        "Callback URL does not match this flow.",
      );
    const code =
      parsed.searchParams.get("error_code") ?? parsed.searchParams.get("error");
    const hash = new URLSearchParams(parsed.hash.slice(1));
    if (code || hash.has("error") || hash.has("error_code"))
      throw failure(
        code ?? hash.get("error_code") ?? hash.get("error") ?? undefined,
      );
    if (!flow.targetPlayerId) {
      const authCode = parsed.searchParams.get("code");
      if (!authCode && !flow.exchanging)
        throw new AccountError(
          "FLOW_MISSING",
          "The callback has no authorization code. Use PKCE with detectSessionInUrl: false.",
        );
      // A completed exchange persists its session in Supabase storage. After interruption,
      // verify that session before retrying a single-use authorization code.
      let recovered = false;
      if (flow.exchanging) {
        const s = await getAuthStatus();
        recovered =
          !s.isAnonymous &&
          s.providers.includes(flow.provider) &&
          (flow.operation !== "link" || s.userId === flow.sourcePlayerId);
      }
      if (!recovered) {
        await store.update(key("flow", flow.id), (value) => {
          const latest = value as AuthFlow | null;
          if (!latest || latest.cancelled)
            throw new AccountError(
              "FLOW_CANCELLED",
              "Authentication was stopped. Staged saves are retained.",
            );
          return { ...latest, exchanging: true };
        });
        const result = await client.auth
          .exchangeCodeForSession(
            authCode!,
            parsed.searchParams.get("sb_flow_id")
              ? { flowId: parsed.searchParams.get("sb_flow_id")! }
              : undefined,
          )
          .catch(() => {
            throw failure();
          });
        if (result.error) throw failure(result.error.code);
      }
    }
    const user = await verifiedAccount(client);
    if (flow.operation === "link" && user.id !== flow.sourcePlayerId)
      throw new AccountError(
        "ACCOUNT_CONFLICT",
        "Linking changed the user unexpectedly. No saves were imported; restore the source session or explicitly sign in.",
      );
    if (
      user.is_anonymous ||
      !user.identities?.some((i) => i.provider === flow.provider) ||
      (flow.targetPlayerId && flow.targetPlayerId !== user.id)
    )
      throw new AccountError(
        "IDENTITY_UNVERIFIED",
        "The expected provider identity could not be verified.",
      );
    await store.update(key("flow", flow.id), () => ({
      ...flow,
      targetPlayerId: user.id,
    }));
    return {
      flowId: flow.id,
      operation: flow.operation,
      userId: user.id,
      ...(flow.transitionId ? { transitionId: flow.transitionId } : {}),
    };
  }
  return {
    getAuthStatus,
    restoreSession: getAuthStatus,
    linkProvider: (p, o) => begin("link", p, o),
    signInWithProvider: (p, o) => begin("signIn", p, o),
    handleAuthCallback(url) {
      if (callback) return callback;
      callback = complete(url);
      void callback
        .finally(() => {
          callback = undefined;
        })
        .catch(() => {});
      return callback;
    },
    async cancelAuthFlow(flowId) {
      const current = await getAuthStatus();
      await store.update(key("flow", flowId), (value) => {
        const flow = value as AuthFlow | null;
        if (!flow || flow.version !== 1 || flow.id !== flowId)
          throw new AccountError(
            "FLOW_MISSING",
            "No matching authentication flow exists.",
          );
        if (flow.targetPlayerId || flow.sourcePlayerId !== current.userId)
          throw new AccountError(
            "ACCOUNT_CHANGED",
            "Authentication has changed. Keep the signed-in account and choose progress, or defer resolution. Guest data is retained; guest credentials were not copied.",
          );
        if (flow.exchanging)
          throw new AccountError(
            "AUTH_IN_PROGRESS",
            "The callback has started. Verify the current account before choosing progress; cancellation cannot undo an exchange.",
          );
        return { ...flow, cancelled: true };
      });
      const after = await getAuthStatus();
      if (after.userId !== current.userId)
        throw new AccountError(
          "ACCOUNT_CHANGED",
          "The account changed concurrently. Guest data is retained; review the signed-in account.",
        );
      return after;
    },
    async signOut() {
      const result = await client.auth.signOut({ scope: "local" }).catch(() => {
        throw failure();
      });
      if (result.error) throw failure(result.error.code);
    },
    onAuthStateChange(fn) {
      return client.auth.onAuthStateChange((event, session) =>
        fn(status(session?.user ?? null), event),
      ).data.subscription;
    },
  };
}
