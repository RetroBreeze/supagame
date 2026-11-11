import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { DesiredFile } from './file-stage.ts';
import { safePath } from './file-stage.ts';

import type { ModuleName } from './versions.ts';
import { moduleMigrations as migrations } from './versions.ts';
export { MODULE_VERSION } from './versions.ts';
export { migrations };
const functionFiles = [
  'index.ts',
  'routes.ts',
  'saves.ts',
  'auth.ts',
  'responses.ts',
  'types.ts',
  'validation.ts',
];
export const templateSources = [
  ...migrations.map(([source]) => source),
  ...functionFiles.map((name) => `modules/leaderboards/functions/supagame/${name}`),
  'packages/contracts/src/generated.ts',
  'deno.lock',
  'modules/legacy/0.1.0.json',
  'modules/legacy/0.1.1.json',
  'modules/legacy/0.1.2.json',
];
export function templateFiles(): DesiredFile[] {
  // Built packages carry the same inventory inside dist/assets; source development
  // reads only this CLI's own repository assets, never a consumer's source tree.
  const built = fileURLToPath(new URL('../assets/', import.meta.url));
  const source = fileURLToPath(new URL('../../../../', import.meta.url));
  const base = import.meta.url.endsWith('.ts') ? source : built;
  const read = (path: string) => readFileSync(join(base, path));
  const files: DesiredFile[] = migrations.map(([source, path]) => ({
    path: `supabase/migrations/${path}`,
    content: read(source),
  }));
  for (const name of functionFiles) {
    let content = read(`modules/leaderboards/functions/supagame/${name}`);
    if (name === 'types.ts') {
      const original = "'../../../../packages/contracts/src/generated.ts'";
      if (!content.toString().includes(original)) {
        throw new Error(
          'CLI template inventory no longer matches the Edge DTO import. Rebuild the CLI with the matching module version.',
        );
      }
      content = Buffer.from(
        content.toString().replace(original, "'./contracts.generated.ts'"),
      );
    }
    files.push({ path: `supabase/functions/supagame/${name}`, content });
  }
  files.push({
    path: 'supabase/functions/supagame/contracts.generated.ts',
    content: read('packages/contracts/src/generated.ts'),
  });
  const lock = JSON.parse(read('deno.lock').toString());
  delete lock.workspace;
  files.push({
    path: 'supabase/functions/supagame/deno.lock',
    content: Buffer.from(JSON.stringify(lock, null, 2) + '\n'),
  });
  files.push({
    path: 'supabase/functions/supagame/deno.json',
    content: Buffer.from(
      JSON.stringify(
        {
          nodeModulesDir: 'none',
          lock: './deno.lock',
          compilerOptions: { strict: true },
        },
        null,
        2,
      ) + '\n',
    ),
  });
  files.push({
    path: 'supabase/functions/supagame/.env.example',
    content: Buffer.from(
      '# Browser origin allowlist; no secrets belong in this file.\nSG_ALLOWED_ORIGINS=["https://your-game.example"]\n# Set SG_AUTH_ISSUER only when Auth uses a different URL from the runtime.\n',
    ),
  });
  return files;
}
export function checkMigrationVersions(root: string): void {
  const directory = safePath(root, 'supabase/migrations');
  if (!existsSync(directory)) return;
  const names = readdirSync(directory);
  for (const [, name] of migrations) {
    const version = name.split('_')[0]!;
    if (
      names.some((other) =>
        other !== name && other.startsWith(`${version}_`) &&
        other.endsWith('.sql')
      )
    ) {
      throw new Error(
        `Migration version ${version} already belongs to another file. Resolve the collision before installation; never rename an applied migration silently.`,
      );
    }
  }
}

export function legacyTemplateFiles(version = '0.1.0'): DesiredFile[] {
 const base = import.meta.url.endsWith('.ts') ? new URL('../../../../', import.meta.url) : new URL('../assets/', import.meta.url);
 const rows = JSON.parse(readFileSync(new URL(`modules/legacy/${version}.json`, base), 'utf8')) as {path:string;content:string}[];
 return rows.map(f => ({path:f.path,content:Buffer.from(f.content,'base64')}));
}

export function migrationModule(path: string): ModuleName | undefined {
  const entry = migrations.find(([,name]) => path === `supabase/migrations/${name}`);
  return entry ? entry[0].split("/")[1] as ModuleName : undefined;
}
