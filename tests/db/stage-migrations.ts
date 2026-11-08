// Test fixture staging only; this is not the provisioning CLI implementation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const migrations = [
  ['../../modules/core/migrations/001_players.sql', '20261108000100_core_players.sql'],
  ['../../modules/leaderboards/migrations/001_leaderboards.sql', '20261108000200_leaderboards.sql'],
  ['../../modules/core/migrations/002_player_functions.sql', '20261108000300_core_player_functions.sql'],
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
