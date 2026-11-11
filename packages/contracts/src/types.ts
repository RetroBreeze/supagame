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

export type Achievement = components['schemas']['Achievement'];

export type SaveRecord = components['schemas']['SaveRecord'];
export type SaveResult = components['schemas']['SaveResult'];
export type SaveList = components['schemas']['SaveList'];
export type SaveUpload = components['schemas']['SaveUpload'];
export type SaveObjects = components['schemas']['SaveObjects'];
export type SaveMutation = components['schemas']['SaveMutation'];

export type SaveRevision = components['schemas']['SaveRevision'];
export type SaveRevisionList = components['schemas']['SaveRevisionList'];

/** Trusted operator command contract; never send operator credentials to game clients. */
export type AdminPermission = 'leaderboards.read' | 'leaderboards.manage' | 'scores.moderate' | 'players.restrict' | 'admins.manage' | 'audit.read';
export type AdminAction = 'leaderboard.reset' | 'leaderboard.disable' | 'leaderboard.enable' | 'score.hide' | 'score.restore' | 'player.restrict' | 'player.reinstate';
export interface AdminOperation { action: AdminAction; target: string; revision: number; operationId: string; reason: string }
export interface AdminAuditRecord { operation_id: string; actor: string; action: AdminAction; target: string; target_type: string; created_at: string; reason: string; outcome: 'applied'; before_state: Record<string, unknown>; after_state: Record<string, unknown> }
