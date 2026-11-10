import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { AuthenticationError } from './errors.js';

/** Only public client capabilities are used; generated database client types remain compatible. */
export type SupabaseConnection = Pick<SupabaseClient, 'auth' | 'functions'> & Partial<Pick<SupabaseClient, 'channel' | 'removeChannel' | 'realtime' | 'storage'>>;
const pendingSignIns = new WeakMap<SupabaseConnection['auth'], Promise<{ userId: string }>>();

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
  const result = await authOperation(() => client.auth.getSession());
  if (result.error) throw new AuthenticationError();
  let session = result.data.session;
  if (session && !usable(session)) {
    const previousId = session.user?.id;
    const refreshed = await authOperation(() => client.auth.refreshSession());
    session = refreshed.data.session;
    if (refreshed.error || !session || !usable(session) || session.user.id !== previousId) throw new AuthenticationError();
  }
  return session;
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
      const result = await authOperation(() => client.auth.getUser(token));
      if (result.error || result.data.user?.id !== session.user.id) throw new AuthenticationError();
    } else {
      const result = await authOperation(() => client.auth.signInAnonymously());
      session = result.data.session;
      if (result.error || !session || !usable(session) || result.data.user?.id !== session.user.id) throw new AuthenticationError();
    }
    return { userId: session.user.id };
  })();
  pendingSignIns.set(client.auth, operation);
  void operation.finally(() => pendingSignIns.delete(client.auth)).catch(() => {});
  return operation;
}
