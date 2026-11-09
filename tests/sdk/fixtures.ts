import { createClient, type Session, type User } from '@supabase/supabase-js';
import { vi } from 'vitest';

export const userId = '00000000-0000-4000-8000-000000000001';
export const key = 'sb_publishable_sdk_test_placeholder';
export const profile = { playerId: userId, displayName: null, createdAt: '2026-11-09T12:00:00Z' };
export const entry = { playerId: userId, displayName: 'Player', score: 50, rank: 1, achievedAt: '2026-11-09T12:00:00.123456Z' };
export function session(anonymous = true, token = 'test-user-token'): Session {
  const user: User = { id: userId, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: profile.createdAt, is_anonymous: anonymous };
  return { user, access_token: token, refresh_token: 'test-refresh-token', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, token_type: 'bearer' };
}
export function fixture(initial: Session | null = session()) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return Response.json(profile);
  });
  const supabase = createClient('https://sdk-test.supabase.co', key, { global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  const getSession = vi.spyOn(supabase.auth, 'getSession').mockResolvedValue(initial ? { data: { session: initial }, error: null } : { data: { session: null }, error: null });
  const signIn = vi.spyOn(supabase.auth, 'signInAnonymously').mockImplementation(async () => {
    const value = session();
    getSession.mockResolvedValue({ data: { session: value }, error: null });
    return { data: { session: value, user: value.user }, error: null };
  });
  const getUser = vi.spyOn(supabase.auth, 'getUser').mockResolvedValue({ data: { user: initial?.user ?? session().user }, error: null });
  const refresh = vi.spyOn(supabase.auth, 'refreshSession').mockImplementation(async () => {
    const value = session(true, 'refreshed-token');
    getSession.mockResolvedValue({ data: { session: value }, error: null });
    return { data: { session: value, user: value.user }, error: null };
  });
  return { supabase, requests, fetcher, getSession, signIn, getUser, refresh };
}
