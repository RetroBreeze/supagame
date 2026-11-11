-- Board SELECT RLS remains the visibility authority. Without Admin, disabled
-- boards remain invisible; with Admin they stay readable and receive hints.
alter policy supagame_live_receive on realtime.messages using (
 extension='broadcast' and exists(select 1 from public.game_leaderboards b
 where realtime.topic()='supagame:leaderboard:'||b.id)
);
