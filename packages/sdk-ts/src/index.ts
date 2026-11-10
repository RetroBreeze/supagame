import { createSaves, type Saves } from './saves.js';
import { createAchievements, type Achievements } from './achievements.js';
import { createTransport, type GameServicesOptions } from './client.js';
import { createPlayers, type Players } from './players.js';
import { createLeaderboards, type Leaderboards } from './leaderboards.js';

export interface GameServices { readonly saves: Saves; readonly achievements: Achievements; readonly players: Players; readonly leaderboards: Leaderboards }
export function createGameServices(options: GameServicesOptions): GameServices {
  const transport = createTransport(options);
  return {
    saves: createSaves(options.supabase, transport),
    achievements: createAchievements(options.supabase, transport),
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

export type { Achievement } from '@supagame/contracts';
export type { Achievements, AchievementSubscription } from './achievements.js';
export { createAchievementQueue } from './achievement-notifications.js';
export type { AchievementQueue } from './achievement-notifications.js';

export type { Saves, SaveOptions, Saved } from './saves.js';
export type { JsonValue } from './save-values.js';
export { operationId as createOperationId } from './save-values.js';
export type { SaveRecord } from '@supagame/contracts';
export { createOfflineSaves } from './offline-saves.js';
export type { LocalStore, SaveStore, OfflineEntry, PendingSave } from './offline-saves.js';
