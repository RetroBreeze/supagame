-- Requires core/001_players.sql. Apply once through the migration ledger.
create schema sg_private;
revoke all on schema sg_private from public, anon, authenticated;

create table public.game_leaderboards (
  id text primary key check (length(id) > 0),
  kind text not null check (kind in ('time', 'points')),
  sort_direction text not null check (sort_direction in ('asc', 'desc')),
  min_value bigint check (min_value between -9007199254740991 and 9007199254740991),
  max_value bigint check (max_value between -9007199254740991 and 9007199254740991),
  enabled boolean not null default true,
  constraint game_leaderboards_bounds_check check (min_value <= max_value)
);

create table public.game_best_scores (
  leaderboard_id text not null references public.game_leaderboards (id) on delete cascade,
  user_id uuid not null references public.game_players (user_id) on delete cascade,
  score bigint not null check (score between -9007199254740991 and 9007199254740991),
  achieved_at timestamptz not null default now(),
  submission_key uuid not null,
  primary key (leaderboard_id, user_id)
);

create table sg_private.game_submission_events (
  user_id uuid not null references public.game_players (user_id) on delete cascade,
  leaderboard_id text not null references public.game_leaderboards (id) on delete cascade,
  submission_key uuid not null,
  submitted_score bigint not null check (submitted_score between -9007199254740991 and 9007199254740991),
  outcome text not null check (outcome in ('best', 'not_best')),
  created_at timestamptz not null default now(),
  primary key (user_id, leaderboard_id, submission_key)
);

-- A backward scan of the ASC index would reverse tie order too, so keep both.
create index game_best_scores_rank_asc_idx on public.game_best_scores
  (leaderboard_id, score asc, achieved_at asc, user_id asc);
create index game_best_scores_rank_desc_idx on public.game_best_scores
  (leaderboard_id, score desc, achieved_at asc, user_id asc);
create index game_submission_events_rate_idx on sg_private.game_submission_events
  (user_id, leaderboard_id, created_at desc);

alter table public.game_leaderboards enable row level security;
alter table public.game_best_scores enable row level security;
alter table sg_private.game_submission_events enable row level security;

revoke all on table public.game_leaderboards, public.game_best_scores,
  sg_private.game_submission_events from public, anon, authenticated;
grant select on public.game_leaderboards to anon, authenticated;
-- Idempotency keys are internal bookkeeping, not part of public leaderboard data.
grant select (leaderboard_id, user_id, score, achieved_at)
  on public.game_best_scores to anon, authenticated;

create policy game_leaderboards_enabled_read on public.game_leaderboards
  for select to anon, authenticated
  using (enabled);

create policy game_best_scores_visible_read on public.game_best_scores
  for select to anon, authenticated
  using (
    -- These caller-scoped subqueries also apply the board/player SELECT policies.
    exists (select 1 from public.game_leaderboards as board where board.id = leaderboard_id)
    and exists (select 1 from public.game_players as player where player.user_id = game_best_scores.user_id)
  );

-- No API policies or grants on events. The schema is not an exposed API schema.
-- No write policies or submission RPCs: those belong to subsequent tasks.
