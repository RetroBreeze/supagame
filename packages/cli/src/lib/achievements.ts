import { object } from "./manifest.ts";
import { sqlLiteral } from "./migration-generator.ts";
export interface AchievementDefinition {
  id: string;
  title: string;
  description: string;
  icon: string | null;
  category: string | null;
  metadata: Record<string, unknown>;
  condition: { type: string; leaderboardId: string; threshold: number };
}
export function isAchievement(v: unknown): v is AchievementDefinition {
  if (
    !object(v) ||
    Object.keys(v).sort().join() !==
      "category,condition,description,icon,id,metadata,title"
  ) return false;
  const text = (x: unknown, max: number) =>
    typeof x === "string" && x.length <= max && !x.includes("\0");
  return typeof v.id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v.id) &&
    text(v.title, 120) && !!v.title && text(v.description, 1000) &&
    (v.icon === null || text(v.icon, 512)) &&
    (v.category === null || text(v.category, 120)) && object(v.metadata) &&
    Buffer.byteLength(JSON.stringify(v.metadata)) <= 16000 &&
    object(v.condition) &&
    Object.keys(v.condition).sort().join() === "leaderboardId,threshold,type" &&
    v.condition.type === "score_threshold" &&
    typeof v.condition.leaderboardId === "string" &&
    Number.isSafeInteger(v.condition.threshold) &&
    Number(v.condition.threshold) >= 0;
}
export function achievementSql(a: AchievementDefinition): Buffer {
  if (!isAchievement(a)) throw new Error("Invalid achievement definition.");
  const value = JSON.stringify(a);
  return Buffer.from(
    `-- Supagame achievement ${a.id}; immutable definition, automatic historical backfill.\ndo $supagame$\ndeclare d jsonb := ${
      sqlLiteral(value)
    }::jsonb;\nbegin\n insert into public.game_achievements(id,title,description,icon,category,metadata,condition_type,leaderboard_id,threshold)\n values(d->>'id',d->>'title',d->>'description',d->>'icon',d->>'category',d->'metadata',d->'condition'->>'type',d->'condition'->>'leaderboardId',(d->'condition'->>'threshold')::bigint) on conflict(id) do nothing;\n if not exists(select 1 from public.game_achievements a where a.id=d->>'id' and a.title=d->>'title' and a.description=d->>'description' and a.icon is not distinct from d->>'icon' and a.category is not distinct from d->>'category' and a.metadata=d->'metadata' and a.condition_type=d->'condition'->>'type' and a.leaderboard_id=d->'condition'->>'leaderboardId' and a.threshold=(d->'condition'->>'threshold')::bigint) then raise exception 'SUPAGAME_ACHIEVEMENT_CONFLICT'; end if;\nend $supagame$;\n`,
  );
}
