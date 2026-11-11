// Test fixture staging only; this is not the provisioning CLI implementation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const migrations = [
 ['../../modules/live-leaderboards/migrations/002_admin_reads.sql','20261111000200_live_admin_reads.sql'],
 ['../../modules/cloud-saves/migrations/007_save_revisions.sql','20261110000306_save_revisions.sql'],
 ['../../modules/cloud-saves/migrations/006_save_throttling.sql','20261110000305_save_throttling.sql'],
 ['../../modules/cloud-saves/migrations/005_garbage_collection.sql','20261110000304_save_garbage_collection.sql'],
 ['../../modules/cloud-saves/migrations/004_storage_preflight.sql','20261110000303_save_storage_preflight.sql'],
 ['../../modules/cloud-saves/migrations/003_upload_quota_guard.sql','20261110000302_save_upload_quota.sql'],
 ['../../modules/cloud-saves/migrations/002_binary_integrity.sql','20261110000301_save_binary_integrity.sql'],
 ['../../modules/cloud-saves/migrations/001_cloud_saves.sql','20261110000300_cloud_saves.sql'],
 ['../../modules/achievements/migrations/001_achievements.sql','20261110000200_achievements.sql'],
  ['../../modules/core/migrations/001_players.sql', '20261108000100_core_players.sql'],
  ['../../modules/leaderboards/migrations/001_leaderboards.sql', '20261108000200_leaderboards.sql'],
  ['../../modules/core/migrations/002_player_functions.sql', '20261108000300_core_player_functions.sql'],
  ['../../modules/leaderboards/migrations/002_submit_score.sql', '20261108000400_submit_score.sql'],
  ['../../modules/leaderboards/migrations/003_rank_reads.sql', '20261108000500_rank_reads.sql'],
  ['../../modules/live-leaderboards/migrations/001_broadcast.sql', '20261110000100_live_leaderboards.sql'],
] as const;
const destination = new URL('../fixtures/local/supabase/migrations/', import.meta.url);
await mkdir(destination, { recursive: true });

for (const [source, filename] of migrations) {
  const content = await readFile(new URL(source, import.meta.url));
  const target = new URL(filename, destination);
  try {
    await writeFile(target, content, { flag: 'wx' });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
    if (!(await readFile(target)).equals(content)) {
      throw new Error(`Fixture migration ${filename} differs; do not rewrite applied migrations.`, { cause: error });
    }
  }
}
