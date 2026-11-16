-- Definition FK checks/deletion otherwise scan the player-leading unlock key.
-- The existing definition threshold index belongs to a different table.
create index game_player_achievements_definition_idx on public.game_player_achievements(achievement_id);
