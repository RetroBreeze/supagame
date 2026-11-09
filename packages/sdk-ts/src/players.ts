import type { PlayerProfile, UpdatePlayerRequest } from '@supagame/contracts';
import { ensureSession, requireSession, type SupabaseConnection } from './auth.js';
import { matches, type Transport } from './client.js';
import { InvalidParameterError } from './errors.js';

export interface Players {
  ensureAnonymousSession(): Promise<{ userId: string }>;
  getMe(): Promise<PlayerProfile>;
  updateMe(input: UpdatePlayerRequest): Promise<PlayerProfile>;
}
export function createPlayers(client: SupabaseConnection, transport: Transport): Players {
  return {
    ensureAnonymousSession: () => ensureSession(client),
    async getMe() {
      return transport.request('/players/me', 'GET', 'PlayerProfile', { session: await requireSession(client) });
    },
    async updateMe(input) {
      // Normalize only the documented name field; never forward caller-supplied identity fields.
      const body = { displayName: typeof input?.displayName === 'string' ? input.displayName.trim() : input?.displayName };
      if (!matches('UpdatePlayerRequest', body) || Object.keys(input).some((key) => key !== 'displayName')) {
        throw new InvalidParameterError('displayName', 'Display names must contain 3–24 printable characters after trimming.');
      }
      return transport.request('/players/me', 'PATCH', 'PlayerProfile', { session: await requireSession(client), body });
    },
  };
}
