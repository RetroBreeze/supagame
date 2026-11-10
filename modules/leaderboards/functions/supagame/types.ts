import type { components } from '../../../../packages/contracts/src/generated.ts';
import type { SupabaseEnv } from 'npm:@supabase/server@1.9.2';

type DTO = components['schemas'];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type FunctionSpec<Args, Returns> = { Args: Args; Returns: Returns };
export interface Database {
  public: {
    Tables: Record<string, never>;
    Views: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
    Functions: {
      sg_get_achievements: FunctionSpec<Record<string, never>, DTO['AchievementList']>;
      sg_list_leaderboards: FunctionSpec<Record<string, never>, DTO['LeaderboardSummary'][]>;
      sg_get_entries: FunctionSpec<
        { p_board_id: string; p_limit: number; p_cursor: Json },
        DTO['LeaderboardPage']
      >;
      sg_get_my_score: FunctionSpec<{ p_board_id: string }, DTO['MyScore'] | null>;
      sg_submit_score: FunctionSpec<
        { p_board_id: string; p_score: number; p_submission_key: string },
        DTO['SubmitScoreResult']
      >;
      sg_get_my_profile: FunctionSpec<Record<string, never>, DTO['PlayerProfile']>;
      sg_update_my_profile: FunctionSpec<{ p_display_name: string }, DTO['PlayerProfile']>;
    };
  };
}
type Functions = Database['public']['Functions'];
export type RpcCall = {
  [Name in keyof Functions]: { name: Name; args: Functions[Name]['Args'] };
}[keyof Functions];
export interface ApiConfig {
  env: SupabaseEnv;
  issuer: string;
  allowedOrigins: readonly string[];
}
