-- Apply once through the migration ledger, before the leaderboards module.
-- Deliberately fail on name collisions rather than adopting an unrelated table.
create table public.game_players (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.game_players enable row level security;

-- Supabase may automatically grant broad public-schema privileges on creation.
-- Only identity and display name belong in public leaderboard reads.
revoke all on table public.game_players from public, anon, authenticated;
grant select (user_id, display_name) on public.game_players to anon, authenticated;

create policy game_players_visible_read on public.game_players
  for select to anon, authenticated
  using (not hidden);

-- Profile writes and private profile reads will be narrowly scoped RPCs in Task 3.
