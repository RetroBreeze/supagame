// Generated CLI SQL runs only in the fixed local Supabase Docker fixture.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  definition,
  leaderboardSql,
  sqlLiteral,
} from '../../packages/cli/src/lib/migration-generator.ts';
import { query } from './local-sessions.ts';

test('generated migration creates a board, repeats safely and preserves a conflicting definition', () => {
  const board = definition('task8-generated-board', {
    type: 'time',
    order: 'asc',
    keepBest: true,
    min: '-9007199254740991',
    max: '9007199254740991',
  });
  const sql = leaderboardSql(board).toString('utf8');
  const conflict = leaderboardSql({ ...board, sortDirection: 'desc' }).toString(
    'utf8',
  );
  const output = query(
    `begin;\n${sql}\n${sql}\ndo $test$\nbegin\n  begin\n    execute ${
      sqlLiteral(conflict)
    };\n    raise exception 'expected conflict';\n  exception when raise_exception then\n    if sqlerrm <> 'SUPAGAME_LEADERBOARD_CONFLICT' then raise; end if;\n  end;\nend $test$;\nselect jsonb_build_object('count', count(*), 'order', min(sort_direction), 'min', min(min_value), 'max', max(max_value)) from public.game_leaderboards where id = 'task8-generated-board';\nrollback;`,
  );
  assert.deepEqual(JSON.parse(output), {
    count: 1,
    order: 'asc',
    min: -9007199254740991,
    max: 9007199254740991,
  });
  assert.equal(
    query(
      "select count(*) from public.game_leaderboards where id = 'task8-generated-board';",
    ),
    '0',
  );
});
test('unbounded generated board is enabled and visible to public readers', () => {
  const sql = leaderboardSql(
    definition('task8-public-board', {
      type: 'points',
      order: 'desc',
      keepBest: true,
    }),
  );
  assert.equal(
    query(
      `begin;\n${
        sql.toString('utf8')
      }\nset local role anon;\nselect kind || ':' || sort_direction from public.game_leaderboards where id = 'task8-public-board' and min_value is null and max_value is null and enabled;\nrollback;`,
    ),
    'points:desc',
  );
});
test('SQL literal escaping round-trips quotes, backslashes, newlines and attempted injection', () => {
  const input = "quote' \\ newline\n'; drop table public.game_players; -- $supagame$";
  assert.equal(
    JSON.parse(query(`select to_json(${sqlLiteral(input)}::text);`)),
    input,
  );
  assert.throws(
    () => definition(input, { type: 'points', order: 'desc', keepBest: true }),
    /Invalid leaderboard/,
  );
  assert.throws(() => sqlLiteral('\0'), /NUL/);
});

test('real Supabase CLI local preview reports an unrelated pending migration without applying it', async () => {
  const { execFileSync } = await import('node:child_process');
  const { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { processEnvironment } = await import('../../packages/cli/src/lib/supabase-cli.ts');
  const fixture = fileURLToPath(new URL('../fixtures/local/supabase/', import.meta.url));
  const executable = fileURLToPath(new URL('../../node_modules/.bin/supabase', import.meta.url));
  const root = mkdtempSync(join(tmpdir(), 'supagame-local-preview-'));
  try {
    mkdirSync(join(root, 'supabase'));
    cpSync(join(fixture, 'config.toml'), join(root, 'supabase/config.toml'));
    cpSync(join(fixture, 'migrations'), join(root, 'supabase/migrations'), { recursive: true });
    const name = '20261111000100_unrelated_preview.sql';
    writeFileSync(join(root, 'supabase/migrations', name), 'select 1;\n');
    const env = processEnvironment(process.env);
    delete env.SUPABASE_ACCESS_TOKEN;
    delete env.SUPABASE_DB_PASSWORD;
    function local(args: string[]) {
      // No remote selector or hosted credentials: fixed running local fixture only.
      const result = JSON.parse(
        execFileSync(executable, [...args, '--workdir', root, '--output-format', 'json'], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 20000,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      );
      assert.equal(result.target.kind, 'local');
      assert.equal(result.target.port, 55432);
      return result;
    }
    const history = local(['migration', 'list']);
    assert.ok(
      history.migrations.some((row: { local: string; remote: string }) =>
        row.local === name.slice(0, 14) && row.remote === ''
      ),
    );
    const preview = local(['db', 'push', '--dry-run', '--include-all', '--skip-vault']);
    assert.deepEqual({
      dryRun: preview.dryRun,
      migrations: preview.migrations,
      seeds: preview.seeds,
      roles: preview.roles,
    }, { dryRun: true, migrations: [name], seeds: [], roles: [] });
    assert.equal(
      query(
        "select count(*) from supabase_migrations.schema_migrations where version = '20261111000100';",
      ),
      '0',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
