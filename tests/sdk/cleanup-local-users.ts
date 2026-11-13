import { execFileSync } from 'node:child_process';
import { sqlLiteral } from '../../packages/cli/src/lib/migration-generator.ts';
import { query } from '../db/local-sessions.ts';

// Only synthetic users created by the calling test in the fixed local fixture.
export async function cleanupLocalUsers(users: readonly string[]) {
  for (const id of users) {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error('Invalid test user ID');
  }
  if (!users.length) return;
  // Operator credential stays in memory. Never accept a caller-supplied target
  // or rely on Edge being healthy to clean up a failed SDK integration test.
  const status = JSON.parse(execFileSync('node_modules/.bin/supabase', [
    'status', '--workdir', 'tests/fixtures/local', '--output', 'json',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  if (status.API_URL !== 'http://127.0.0.1:55431' || !status.SERVICE_ROLE_KEY) {
    throw new Error('Cleanup requires the dedicated local Supabase fixture');
  }
  const selectedUsers = users.map(sqlLiteral).join(',');
  query(`delete from auth.users where id in (${selectedUsers})`);
  // Auth deletion cascades slots/revisions, but deliberately retains the object
  // registry until physical deletion succeeds. Include pending uploads too.
  for (;;) {
    const paths: string[] = JSON.parse(query(`select coalesce(jsonb_agg(path),'[]'::jsonb)
      from (select path from sg_private.save_objects where user_id in (${selectedUsers}) order by path limit 100) objects`));
    if (!paths.length) return;
    const array = `array[${paths.map(sqlLiteral).join(',')}]::text[]`;
    const prepared: string[] = JSON.parse(query(`select coalesce(jsonb_agg(path),'[]'::jsonb)
      from sg_private.prepare_save_cleanup(${array}) path`));
    if (prepared.length !== paths.length) throw new Error('Test object cleanup could not prepare every object');
    const response = await fetch(`${status.API_URL}/storage/v1/object/supagame-saves`, {
      method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { apikey: status.SERVICE_ROLE_KEY, authorization: `Bearer ${status.SERVICE_ROLE_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: prepared }),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error('Local Storage cleanup failed; object registry retained for retry');
    const removed = query(`select sg_private.finish_save_cleanup(${array})`);
    if (Number(removed) !== paths.length) throw new Error('Local Storage objects remain; cleanup registry retained');
  }
}
