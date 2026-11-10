import { createTransport, type GameServicesOptions } from './client.js';
import { createPlayers, type Players } from './players.js';
import { createLeaderboards, type Leaderboards } from './leaderboards.js';

export interface GameServices { readonly players: Players; readonly leaderboards: Leaderboards }
export function createGameServices(options: GameServicesOptions): GameServices {
  const transport = createTransport(options);
  return {
    players: createPlayers(options.supabase, transport),
    leaderboards: createLeaderboards(options.supabase, transport),
  };
}
export type { GameServicesOptions } from './client.js';
export type { Players } from './players.js';
export type { Leaderboards, PageOptions } from './leaderboards.js';
export * from './errors.js';
export type { PlayerProfile, UpdatePlayerRequest, LeaderboardEntry, LeaderboardPage, MyScore, SubmitScoreRequest, SubmitScoreResult, ApiError as ApiErrorBody } from '@supagame/contracts';

export type { LiveOptions, LiveStatus, LiveSubscription, RankChange } from './live.js';
