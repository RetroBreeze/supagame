import { executePlan, planFiles } from "../lib/file-stage.ts";
import { MANIFEST, manifestBytes, readManifest } from "../lib/manifest.ts";
import {
  type AchievementDefinition,
  achievementSql,
} from "../lib/achievements.ts";
import { migrations, nextVersion } from "../lib/migration-generator.ts";
import { type LocalOptions, readProject, selectedRef } from "../lib/project.ts";
import { MODULE_VERSION } from "../lib/templates.ts";
export function createAchievement(
  id: string,
  options: LocalOptions & {
    title: string;
    description: string;
    board: string;
    threshold: string;
    icon?: string;
    category?: string;
    metadata?: string;
  },
) {
  const { root } = readProject(options), existing = readManifest(root);
  if (!existing || existing.value.modules.achievements !== MODULE_VERSION) {
    throw new Error("Run supagame add achievements first.");
  }
  selectedRef(root, undefined, existing.value.projectRef);
  if (!/^(0|[1-9]\d*)$/.test(options.threshold)) {
    throw new Error("Threshold must be a nonnegative safe integer.");
  }
  const a: AchievementDefinition = {
    id,
    title: options.title,
    description: options.description,
    icon: options.icon ?? null,
    category: options.category ?? null,
    metadata: JSON.parse(options.metadata ?? "{}"),
    condition: {
      type: "score_threshold",
      leaderboardId: options.board,
      threshold: Number(options.threshold),
    },
  };
  const content = achievementSql(a),
    definitions = existing.value.achievements ?? [];
  const previous = definitions.find((d) => d.id === id);
  if (previous && !achievementSql(previous).equals(content)) {
    throw new Error(
      "Achievement IDs are immutable; use a new ID for a new rule.",
    );
  }
  const files = migrations(root),
    suffix = `_supagame_achievement_${id}.sql`,
    matches = files.filter((f) => f.name.endsWith(suffix));
  if (matches.length > 1 || (previous && !matches.length)) {
    throw new Error("Restore original achievement migration.");
  }
  const name = matches[0]?.name ?? nextVersion(files) + suffix;
  const value = {
    ...existing.value,
    achievements: previous ? definitions : [...definitions, a],
  };
  executePlan(
    root,
    planFiles(root, [{ path: `supabase/migrations/${name}`, content }, {
      path: MANIFEST,
      content: manifestBytes(value),
      replace: existing.bytes,
    }]),
    options.dryRun ?? false,
  );
}
