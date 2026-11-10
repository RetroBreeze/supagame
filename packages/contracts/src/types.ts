import type { components } from './generated.js';

/** Public wire DTOs, derived from openapi.yaml. Numeric bounds require runtime validation. */
export type LeaderboardSummary = components['schemas']['LeaderboardSummary'];
export type LeaderboardEntry = components['schemas']['LeaderboardEntry'];
export type LeaderboardPage = components['schemas']['LeaderboardPage'];
export type MyScore = components['schemas']['MyScore'];
export type SubmitScoreRequest = components['schemas']['SubmitScoreRequest'];
export type SubmitScoreResult = components['schemas']['SubmitScoreResult'];
export type PlayerProfile = components['schemas']['PlayerProfile'];
export type UpdatePlayerRequest = components['schemas']['UpdatePlayerRequest'];
export type ApiError = components['schemas']['ApiError'];

/** Realtime Broadcast v1 invalidation. Rankings are read through the HTTP API. */
export interface LiveLeaderboardInvalidation { boardId: string }
