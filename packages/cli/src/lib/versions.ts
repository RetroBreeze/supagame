import { legacyTemplateFiles } from "./templates.ts";
import type { DesiredFile } from "./file-stage.ts";

export type ModuleName =
  | "core"
  | "leaderboards"
  | "live-leaderboards"
  | "achievements"
  | "cloud-saves";
export const MODULE_VERSION = "0.1.2";
export const moduleMigrations = [
  [
    "modules/cloud-saves/migrations/006_save_throttling.sql",
    "20261110000305_save_throttling.sql",
  ],
  [
    "modules/cloud-saves/migrations/005_garbage_collection.sql",
    "20261110000304_save_garbage_collection.sql",
  ],
  [
    "modules/cloud-saves/migrations/004_storage_preflight.sql",
    "20261110000303_save_storage_preflight.sql",
  ],
  [
    "modules/cloud-saves/migrations/003_upload_quota_guard.sql",
    "20261110000302_save_upload_quota.sql",
  ],
  [
    "modules/cloud-saves/migrations/001_cloud_saves.sql",
    "20261110000300_cloud_saves.sql",
  ],
  [
    "modules/cloud-saves/migrations/002_binary_integrity.sql",
    "20261110000301_save_binary_integrity.sql",
  ],
  [
    "modules/core/migrations/001_players.sql",
    "20261108000100_core_players.sql",
  ],
  [
    "modules/leaderboards/migrations/001_leaderboards.sql",
    "20261108000200_leaderboards.sql",
  ],
  [
    "modules/core/migrations/002_player_functions.sql",
    "20261108000300_core_player_functions.sql",
  ],
  [
    "modules/leaderboards/migrations/002_submit_score.sql",
    "20261108000400_submit_score.sql",
  ],
  [
    "modules/leaderboards/migrations/003_rank_reads.sql",
    "20261108000500_rank_reads.sql",
  ],
  [
    "modules/live-leaderboards/migrations/001_broadcast.sql",
    "20261110000100_live_leaderboards.sql",
  ],
  [
    "modules/achievements/migrations/001_achievements.sql",
    "20261110000200_achievements.sql",
  ],
] as const;
export interface ModuleRelease {
  module: ModuleName;
  version: string;
  previous?: string | undefined;
  requiresCore?: string;
  requiresLeaderboards?: string;
  // Cumulative immutable SQL history and the complete asset snapshot for this release.
  migrations: readonly DesiredFile[];
  assets: readonly DesiredFile[];
}
export type Inventory = readonly ModuleRelease[];
export function currentInventory(files: readonly DesiredFile[]): Inventory {
  const names: ModuleName[] = [
    "core",
    "leaderboards",
    "live-leaderboards",
    "achievements",
    "cloud-saves",
  ];
  const releases = names.map((module) => ({
    module,
    version: MODULE_VERSION,
    ...(module !== "cloud-saves" ? { previous: "0.1.1" } : {}),
    ...(module === "leaderboards" ? { requiresCore: MODULE_VERSION } : {}),
    ...(["live-leaderboards", "achievements", "cloud-saves"].includes(module)
      ? { requiresLeaderboards: MODULE_VERSION }
      : {}),
    migrations: files
      .filter((file) =>
        moduleMigrations.some(
          ([source, name]) =>
            source.startsWith(`modules/${module}/`) &&
            file.path === `supabase/migrations/${name}`,
        ),
      )
      .sort((a, b) => a.path.localeCompare(b.path)),
    assets:
      module === "leaderboards"
        ? files.filter((f) => f.path.startsWith("supabase/functions/supagame/"))
        : [],
  }));
  const old = (version: string, modules: ModuleName[]) =>
    modules.map((module) => {
      const release = releases.find((r) => r.module === module)!;
      const snapshot = legacyTemplateFiles(version);
      return {
        ...release,
        version,
        previous:
          version === "0.1.1" && module !== "achievements"
            ? "0.1.0"
            : undefined,
        ...(release.requiresCore ? { requiresCore: version } : {}),
        ...(release.requiresLeaderboards
          ? { requiresLeaderboards: version }
          : {}),
        assets:
          module === "leaderboards"
            ? snapshot.filter((f) =>
                f.path.startsWith("supabase/functions/supagame/"),
              )
            : [],
      };
    });
  return [
    ...old("0.1.0", ["core", "leaderboards", "live-leaderboards"]),
    ...old("0.1.1", [
      "core",
      "leaderboards",
      "live-leaderboards",
      "achievements",
    ]),
    ...releases,
  ];
}
function components(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(
      "Inventory version must be a canonical stable semantic version.",
    );
  }
  const parts = version.split(".").map(Number);
  if (!parts.every(Number.isSafeInteger)) {
    throw new Error("Inventory version is too large.");
  }
  return parts;
}
export function compareVersions(a: string, b: string): number {
  const left = components(a),
    right = components(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i]! < right[i]! ? -1 : 1;
  }
  return 0;
}
export function validateInventory(inventory: Inventory): void {
  const identities = new Set<string>();
  const migrationOwners = new Map<
    string,
    { module: ModuleName; path: string; content: Buffer }
  >();
  for (const release of inventory) {
    components(release.version);
    const key = `${release.module}@${release.version}`;
    if (identities.has(key)) {
      throw new Error(`Duplicate inventory release ${key}.`);
    }
    identities.add(key);
    if (
      ![
        "core",
        "leaderboards",
        "live-leaderboards",
        "achievements",
        "cloud-saves",
      ].includes(release.module)
    ) {
      throw new Error("Unknown inventory module.");
    }
    const paths = new Set<string>();
    for (const file of [...release.migrations, ...release.assets]) {
      const sql = release.migrations.includes(file);
      if (
        !Buffer.isBuffer(file.content) ||
        (sql
          ? !/^supabase\/migrations\/\d{14}_[a-zA-Z0-9_-]+\.sql$/.test(
              file.path,
            )
          : !/^supabase\/functions\/supagame\/[a-zA-Z0-9_.-]+$/.test(
              file.path,
            )) ||
        file.replace !== undefined ||
        paths.has(file.path)
      ) {
        throw new Error(
          `Invalid inventory path or duplicate asset: ${file.path}.`,
        );
      }
      paths.add(file.path);
      if (sql) {
        const version = file.path.split("/").at(-1)!.slice(0, 14);
        const known = migrationOwners.get(version);
        if (
          known &&
          (known.module !== release.module || known.path !== file.path)
        ) {
          throw new Error(`Inventory migration version collision: ${version}.`);
        }
        if (known && !known.content.equals(file.content)) {
          throw new Error("Inventory cannot rewrite an existing migration.");
        }
        migrationOwners.set(version, {
          module: release.module,
          path: file.path,
          content: file.content,
        });
      }
    }
    if (
      release.module === "leaderboards" &&
      !inventory.some(
        (r) => r.module === "core" && r.version === release.requiresCore,
      )
    )
      throw new Error("Inventory has an incompatible core dependency.");
    if (
      (release.module === "live-leaderboards" ||
        release.module === "achievements" ||
        release.module === "cloud-saves") &&
      !inventory.some(
        (r) =>
          r.module === "leaderboards" &&
          r.version === release.requiresLeaderboards,
      )
    )
      throw new Error("Inventory has an incompatible leaderboards dependency.");
    if (release.previous) {
      const old = inventory.find(
        (r) => r.module === release.module && r.version === release.previous,
      );
      if (!old || compareVersions(old.version, release.version) >= 0) {
        throw new Error(
          "Inventory upgrade must be forward-only with a known predecessor.",
        );
      }
      for (const file of old.migrations) {
        if (
          !release.migrations.some(
            (f) => f.path === file.path && f.content.equals(file.content),
          )
        ) {
          throw new Error(
            "Inventory cannot rewrite or remove an existing migration.",
          );
        }
      }
      for (const file of old.assets) {
        if (!release.assets.some((f) => f.path === file.path)) {
          throw new Error("Inventory cannot remove an existing asset.");
        }
      }
      const last = old.migrations
        .map((f) => f.path)
        .sort()
        .at(-1);
      for (const file of release.migrations) {
        if (
          !old.migrations.some((f) => f.path === file.path) &&
          last &&
          file.path <= last
        ) {
          throw new Error(
            "New migrations must follow the previous schema version.",
          );
        }
      }
    }
  }
}
export function releaseFor(
  inventory: Inventory,
  module: ModuleName,
  version: string,
): ModuleRelease {
  const release = inventory.find(
    (r) => r.module === module && r.version === version,
  );
  if (!release) {
    throw new Error(
      `Incompatible or unknown ${module} version ${version}; use the matching CLI release. No downgrade or guessed upgrade is supported.`,
    );
  }
  return release;
}
export function latestRelease(
  inventory: Inventory,
  module: ModuleName,
): ModuleRelease {
  const release = inventory
    .filter((r) => r.module === module)
    .sort((a, b) => compareVersions(a.version, b.version))
    .at(-1);
  if (!release) throw new Error(`No release inventory for ${module}.`);
  return release;
}
export function upgradePath(
  inventory: Inventory,
  installed: ModuleRelease,
): ModuleRelease {
  const latest = latestRelease(inventory, installed.module);
  let cursor = latest;
  while (cursor.version !== installed.version) {
    if (!cursor.previous) {
      throw new Error(
        `No known forward-only upgrade path for ${installed.module} ${installed.version}.`,
      );
    }
    cursor = releaseFor(inventory, installed.module, cursor.previous);
  }
  return latest;
}
