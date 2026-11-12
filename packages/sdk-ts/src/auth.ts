import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { AuthenticationError } from './errors.js';

/** Only public client capabilities are used; generated database client types remain compatible. */
export type SupabaseConnection = Pick<SupabaseClient, 'auth' | 'functions'> & Partial<Pick<SupabaseClient, 'channel' | 'removeChannel' | 'realtime' | 'storage'>>;
const pendingSignIns = new WeakMap<SupabaseConnection['auth'], Promise<{ userId: string }>>();

// One observer per Auth client, shared by every SDK instance. No Auth methods
// are called inside its callback (Supabase holds its Auth lock there).
const identities = new WeakMap<SupabaseConnection['auth'], { epoch: number; user?: string | null }>();
const sessions = new WeakMap<Session, number>();
function identity(client: SupabaseConnection) {
  let state = identities.get(client.auth);
  if (!state) {
    state = { epoch: 0 };
    identities.set(client.auth, state);
    const observed = state;
    // Older host/test adapters may expose only the session methods. They still
    // get active-player checks; only an event source can detect unobserved ABA.
    client.auth.onAuthStateChange?.((event, session) => {
      if (event === 'INITIAL_SESSION') return;
      const user = session?.user.id ?? null;
      if (event === 'SIGNED_OUT' || (observed.user !== undefined && observed.user !== user)) observed.epoch++;
      observed.user = user;
    });
  }
  return state;
}
export function identityEpoch(client: SupabaseConnection): number { return identity(client).epoch; }
export function assertEpoch(client: SupabaseConnection, epoch: number): void {
  if (identity(client).epoch !== epoch) throw new AuthenticationError('The player changed during the operation.');
}
export function assertSessionEpoch(client: SupabaseConnection, session: Session): void {
  assertEpoch(client, sessions.get(session) ?? identityEpoch(client));
}
/** Check both the active identity and observed switch-away-and-back events. */
export async function assertSession(client: SupabaseConnection, session: Session): Promise<void> {
  const epoch = sessions.get(session) ?? identityEpoch(client);
  assertEpoch(client, epoch);
  const current = await requireSession(client);
  assertEpoch(client, epoch);
  if (current.user.id !== session.user.id) throw new AuthenticationError('The player changed during the operation.');
}
/** Also supports signed-out OAuth initiation; the expected transition occurs
 * only at exchange/sign-out, where callers explicitly establish a new scope. */
export async function captureIdentity(client: SupabaseConnection): Promise<() => Promise<void>> {
  const session = await readSession(client), epoch = identityEpoch(client);
  return async () => {
    assertEpoch(client, epoch);
    const current = await readSession(client);
    assertEpoch(client, epoch);
    if ((current?.user.id ?? null) !== (session?.user.id ?? null)) throw new AuthenticationError('The player changed during the operation.');
  };
}
/** Protect successful values and private error payloads across one I/O boundary. */
export async function checkedResult<T>(check: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  await check();
  let result: T;
  try { result = await work(); }
  catch (error) { await check(); throw error; }
  await check();
  return result;
}
export function sessionResult<T>(client: SupabaseConnection, session: Session, work: () => Promise<T>): Promise<T> {
  return checkedResult(() => assertSession(client, session), work);
}

async function authOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch { throw new AuthenticationError(); }
}
function usable(session: Session | null): boolean {
  return !!session?.access_token && !!session.user?.id &&
    typeof session.expires_at === 'number' && Number.isFinite(session.expires_at) &&
    session.expires_at > Date.now() / 1000;
}

/** getSession owns normal refresh. A stale session is refreshed through that same client. */
export async function readSession(client: SupabaseConnection): Promise<Session | null> {
  const state = identity(client), epoch = state.epoch;
  const result = await authOperation(() => client.auth.getSession());
  assertEpoch(client, epoch);
  if (result.error) throw new AuthenticationError();
  let session = result.data.session;
  if (session && !usable(session)) {
    const previousId = session.user?.id;
    const refreshed = await authOperation(() => client.auth.refreshSession());
    session = refreshed.data.session;
    if (refreshed.error || !session || !usable(session) || session.user.id !== previousId) throw new AuthenticationError();
  }
  assertEpoch(client, epoch);
  const user = session?.user.id ?? null;
  if (state.user !== undefined && state.user !== user) state.epoch++;
  state.user = user;
  if (!session) return null;
  // Auth may reuse its Session object; each operation needs an immutable identity
  // snapshot and its own epoch, never a stamp overwritten by a later acquisition.
  const snapshot = { ...session, user: { ...session.user } };
  sessions.set(snapshot, state.epoch);
  return snapshot;
}
export async function requireSession(client: SupabaseConnection): Promise<Session> {
  const session = await readSession(client);
  if (!session) throw new AuthenticationError();
  return session;
}

export function ensureSession(client: SupabaseConnection): Promise<{ userId: string }> {
  const pending = pendingSignIns.get(client.auth);
  if (pending) return pending;
  const operation = (async () => {
    let session = await readSession(client);
    if (session) {
      // Ask Auth to validate an existing identity; never replace a rejected identity anonymously.
      const token = session.access_token;
      const result = await sessionResult(client, session, () => authOperation(() => client.auth.getUser(token)));
      if (result.error || result.data.user?.id !== session.user.id) throw new AuthenticationError();
    } else {
      const result = await authOperation(() => client.auth.signInAnonymously());
      session = result.data.session;
      if (result.error || !session || !usable(session) || result.data.user?.id !== session.user.id) throw new AuthenticationError();
      const current = await requireSession(client);
      if (current.user.id !== session.user.id) throw new AuthenticationError();
      session = current;
    }
    await assertSession(client, session);
    return { userId: session.user.id };
  })();
  pendingSignIns.set(client.auth, operation);
  void operation.finally(() => pendingSignIns.delete(client.auth)).catch(() => {});
  return operation;
}
