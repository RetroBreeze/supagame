import type { LeaderboardPage, MyScore, SubmitScoreResult } from '@supagame/contracts';
import { requireSession, type SupabaseConnection } from './auth.js';
import { matches, type Transport } from './client.js';
import { AuthenticationError, GameServicesError, InvalidParameterError, NetworkError } from './errors.js';

export interface PageOptions { limit?: number; cursor?: string }
export interface Leaderboards {
  getTop(id: string, options?: PageOptions): Promise<LeaderboardPage>;
  getMine(id: string): Promise<MyScore | null>;
  submit(id: string, score: number, submissionKey?: string): Promise<SubmitScoreResult>;
}
function boardPath(id: string): string {
  if (typeof id !== 'string' || !id.length || id === '.' || id === '..') throw new InvalidParameterError('id', 'A nonempty leaderboard ID is required.');
  try { return `/leaderboards/${encodeURIComponent(id)}`; }
  catch { throw new InvalidParameterError('id', 'The leaderboard ID must contain valid Unicode.'); }
}
function submissionUuid(): string {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) throw new InvalidParameterError('submissionKey', 'Secure UUID generation is unavailable; supply a UUID submissionKey.');
  if (crypto.randomUUID) return crypto.randomUUID();
  // Web Crypto fallback for WebViews without randomUUID. Never use Math.random.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function createLeaderboards(client: SupabaseConnection, transport: Transport): Leaderboards {
  return {
    async getTop(id, options = {}) {
      const path = boardPath(id);
      const limit = options?.limit === undefined ? 50 : options.limit;
      if (!options || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidParameterError('limit', 'Page limits must be integers from 1 to 100.');
      const query = new URLSearchParams({ limit: String(limit) });
      if (options.cursor !== undefined) {
        if (typeof options.cursor !== 'string' || !options.cursor.length) throw new InvalidParameterError('cursor', 'A cursor must be a nonempty opaque string returned by the API.');
        query.set('cursor', options.cursor);
      }
      return transport.request(`${path}/entries?${query}`, 'GET', 'LeaderboardPage');
    },
    async getMine(id) {
      const path = boardPath(id);
      return transport.request(`${path}/me`, 'GET', 'MyScore', { session: await requireSession(client), nullable: true });
    },
    async submit(id, score, submissionKey) {
      const path = boardPath(id);
      if (!Number.isSafeInteger(score)) throw new InvalidParameterError('score', 'Scores must be safe integers.');
      const key = submissionKey === undefined ? submissionUuid() : submissionKey;
      const body = { score, submissionKey: key };
      if (!matches('SubmitScoreRequest', body)) throw new InvalidParameterError('submissionKey', 'submissionKey must be a UUID.');
      try {
        const initial = await requireSession(client);
        try {
          return await transport.request(`${path}/scores`, 'POST', 'SubmitScoreResult', { session: initial, body });
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error;
          // One retry for a lost response, using the same key and identity. SQL owns deduplication.
          const current = await requireSession(client);
          if (current.user.id !== initial.user.id) throw new AuthenticationError('The player changed during submission. Retry only with the original player session.');
          return await transport.request(`${path}/scores`, 'POST', 'SubmitScoreResult', { session: current, body });
        }
      } catch (error) {
        if (error instanceof GameServicesError) error.submissionKey = key;
        throw error;
      }
    },
  };
}
