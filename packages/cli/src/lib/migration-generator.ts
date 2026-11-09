import { readdirSync } from 'node:fs';
import { readProjectFile, safePath } from './file-stage.ts';
import { isLeaderboard } from './manifest.ts';
import type { LeaderboardDefinition } from './manifest.ts';

export interface BoardOptions {
  type?: string;
  order?: string;
  keepBest?: boolean;
  min?: string;
  max?: string;
}
export function definition(
  id: string,
  options: BoardOptions,
): LeaderboardDefinition {
  function bound(value: string | undefined): number | null {
    if (value === undefined) return null;
    if (
      !/^-?(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))
    ) {
      throw new Error(
        'Score bounds must be decimal safe integers (−9007199254740991 through 9007199254740991).',
      );
    }
    return Number(value);
  }
  const board = {
    id,
    kind: options.type,
    sortDirection: options.order,
    keepBest: options.keepBest,
    minValue: bound(options.min),
    maxValue: bound(options.max),
  };
  if (!isLeaderboard(board)) {
    throw new Error(
      'Invalid leaderboard: use a lowercase alphanumeric/hyphen ID (1–64 characters), --type time|points, --order asc|desc, --keep-best and min <= max.',
    );
  }
  return board;
}
export function sqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('SQL text cannot contain NUL.');
  return "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''") + "'";
}
export function leaderboardSql(board: LeaderboardDefinition): Buffer {
  // Revalidate even when called outside Commander; never interpolate untrusted numbers.
  const b = definition(board.id, {
    type: board.kind,
    order: board.sortDirection,
    keepBest: board.keepBest,
    ...(board.minValue === null ? {} : { min: String(board.minValue) }),
    ...(board.maxValue === null ? {} : { max: String(board.maxValue) }),
  });
  const id = sqlLiteral(b.id),
    kind = sqlLiteral(b.kind),
    order = sqlLiteral(b.sortDirection);
  const min = b.minValue === null ? 'null' : String(b.minValue),
    max = b.maxValue === null ? 'null' : String(b.maxValue);
  return Buffer.from(
    `-- Supagame leaderboard ${b.id}; additive, immutable definition.\n-- keepBest is always true; enforced by sg_submit_score.\ndo $supagame$\nbegin\n  insert into public.game_leaderboards (id, kind, sort_direction, min_value, max_value, enabled)\n  values (${id}, ${kind}, ${order}, ${min}, ${max}, true)\n  on conflict (id) do nothing;\n\n  perform 1 from public.game_leaderboards where id = ${id} for update;\n  if not exists (\n    select 1 from public.game_leaderboards\n    where id = ${id} and kind = ${kind} and sort_direction = ${order}\n      and min_value is not distinct from ${min}::bigint\n      and max_value is not distinct from ${max}::bigint and enabled\n  ) then\n    raise exception 'SUPAGAME_LEADERBOARD_CONFLICT';\n  end if;\nend\n$supagame$;\n`,
  );
}
export interface MigrationFile {
  name: string;
  version: string;
  content: Buffer;
}
export function migrations(root: string): MigrationFile[] {
  const directory = safePath(root, 'supabase/migrations');
  const versions = new Set<string>();
  return readdirSync(directory).sort().flatMap((name) => {
    if (name === '.gitkeep' || name === '.gitignore') return [];
    if (!/^\d{14}_[a-zA-Z0-9_-]+\.sql$/.test(name)) {
      throw new Error(
        `Cannot safely inventory migration ${
          JSON.stringify(name)
        }. Use unique 14-digit timestamp_name.sql files.`,
      );
    }
    const version = name.slice(0, 14);
    if (versions.has(version)) {
      throw new Error(
        `Duplicate migration version ${version}. Resolve it before continuing.`,
      );
    }
    versions.add(version);
    return [{
      name,
      version,
      content: readProjectFile(root, `supabase/migrations/${name}`)!,
    }];
  });
}
export function nextVersion(files: MigrationFile[]): string {
  const latest = files.at(-1)?.version ?? '20261108000500';
  const iso = `${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6, 8)}T${
    latest.slice(8, 10)
  }:${latest.slice(10, 12)}:${latest.slice(12)}.000Z`;
  const time = new Date(iso);
  if (!Number.isFinite(time.getTime()) || time.toISOString() !== iso) {
    throw new Error(
      `Migration version ${latest} is not a valid UTC timestamp.`,
    );
  }
  const next = new Date(time.getTime() + 1000).toISOString().replace(
    /[-:TZ.]/g,
    '',
  ).slice(0, 14);
  if (!/^\d{14}$/.test(next) || next <= latest) {
    throw new Error('Migration version exhausted.');
  }
  return next;
}
