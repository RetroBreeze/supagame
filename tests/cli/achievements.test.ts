import { deploymentFiles } from '../../packages/cli/src/lib/deployment-files.ts';
import { describe, expect, it } from "vitest";
import { validateManifest } from "../../packages/cli/src/lib/manifest.ts";
import { achievementSql } from "../../packages/cli/src/lib/achievements.ts";
const achievement = {
  id: "coins-500",
  title: "Collector",
  description: "Collect 500 in one run.",
  icon: "coin",
  category: "coins",
  metadata: {},
  condition: {
    type: "score_threshold",
    leaderboardId: "coins",
    threshold: 500,
  },
};
const manifest = {
  formatVersion: 1,
  projectRef: "abcdefghijklmnopqrst",
  modules: { core: "0.1.0", leaderboards: "0.1.0", achievements: "0.1.0" },
  leaderboards: [{
    id: "coins",
    kind: "points",
    sortDirection: "desc",
    keepBest: true,
    minValue: 0,
    maxValue: 20000,
  }],
  achievements: [achievement],
};
describe("achievement configuration", () => {
  it("accepts definitions bound to configured descending boards", () =>
    expect(validateManifest(manifest)).toEqual(manifest));
  it("rejects duplicate IDs, unsafe thresholds and missing boards", () => {
    for (
      const achievements of [[achievement, achievement], [{
        ...achievement,
        condition: { ...achievement.condition, threshold: NaN },
      }], [{
        ...achievement,
        condition: { ...achievement.condition, leaderboardId: "missing" },
      }]]
    ) expect(() => validateManifest({ ...manifest, achievements })).toThrow();
  });
  it("generates immutable registration with backfill and safely escaped text", () => {
    const sql = achievementSql({ ...achievement, title: "Collector's" })
      .toString();
    expect(sql).toContain("Collector''s");
    expect(sql).toContain("game_achievements");
    expect(sql).toContain("SUPAGAME_ACHIEVEMENT_CONFLICT");
  });
});

import {
  cli,
  initialized,
  manifest as readTestManifest,
  project,
  snapshot,
} from "./project-fixture.ts";
import { rmSync } from "node:fs";
it("installs, registers, previews, diagnoses and repeats without mutations", () => {
  const root = project();
  initialized(root);
  try {
    const before = snapshot(root);
    expect(cli(root, "add", "achievements", "--dry-run").status).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(cli(root, "add", "achievements").status).toBe(0);
    expect(
      cli(
        root,
        "leaderboard",
        "create",
        "coins",
        "--type",
        "points",
        "--order",
        "desc",
        "--keep-best",
      ).status,
    ).toBe(0);
    const args = [
      "achievement",
      "create",
      "coins-500",
      "--title",
      "Collector",
      "--description",
      "One run",
      "--board",
      "coins",
      "--threshold",
      "500",
    ];
    expect(cli(root, ...args).status).toBe(0);
    const staged = snapshot(root);
    expect(cli(root, ...args).status).toBe(0);
    expect(cli(root, "add", "achievements").status).toBe(0);
    expect(snapshot(root)).toEqual(staged);
    expect(readTestManifest(root).achievements).toHaveLength(1);
    expect([...deploymentFiles(root, ref).owned].some(name => name.endsWith("_achievements.sql"))).toBe(true);
    const doctor = cli(root, "doctor");
    expect(doctor.status, doctor.stdout).toBe(0);
    expect(doctor.stdout).toContain("achievement:coins-500");
    expect(cli(root, "upgrade", "--dry-run").status).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

import { legacyTemplateFiles } from "../../packages/cli/src/lib/templates.ts";
import { put, ref } from "./project-fixture.ts";
it("upgrades known 0.1.0 assets before installing achievements without rewriting SQL", () => {
  const root = project();
  try {
    for (const file of legacyTemplateFiles()) {
      put(root, file.path, file.content.toString());
    }
    put(
      root,
      "supabase/config.toml",
      'project_id="legacy"\n[functions.supagame]\nverify_jwt=false\nentrypoint="./functions/supagame/index.ts"\nimport_map="./functions/supagame/deno.json"\n',
    );
    put(
      root,
      "supagame.config.json",
      JSON.stringify({
        formatVersion: 1,
        projectRef: ref,
        modules: {
          core: "0.1.0",
          leaderboards: "0.1.0",
          "live-leaderboards": "0.1.0",
        },
        leaderboards: [],
      }),
    );
    const before = snapshot(root);
    const dry = cli(root, "upgrade", "--dry-run");
    expect(dry.status, dry.stderr).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const result = cli(root, "upgrade");
    expect(result.status, result.stderr).toBe(0);
    expect(cli(root, "add", "achievements").status).toBe(0);
    for (const [path, value] of Object.entries(before)) {
      if (path.includes("/migrations/")) {
        expect(snapshot(root)[path]).toEqual(value);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
