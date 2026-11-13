import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { query } from '../db/local-sessions.ts';
import { cleanupLocalUsers } from './cleanup-local-users.ts';

const status = JSON.parse(execFileSync('node_modules/.bin/supabase', [
  'status', '--workdir', 'tests/fixtures/local', '--output', 'json',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
if (status.API_URL !== 'http://127.0.0.1:55431') throw new Error('Expected the local test fixture');

it.each([false, true])('cleans failed SDK test users after prepare (uploaded: %s), preserving other users', async (upload) => {
  const users: string[] = [];
  const paths: string[] = [];
  try {
    // Both reservations and bytes use real Auth/PostgREST/Storage. Edge need not
    // be running: the original failure happened after upload, before Edge commit.
    for (let i = 0; i < 2; i++) {
      const client = createClient(status.API_URL, status.PUBLISHABLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const signed = await client.auth.signInAnonymously();
      expect(signed.error).toBeNull();
      users.push(signed.data.user!.id);
      const bytes = new TextEncoder().encode('unfinished');
      const checksum = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
      const prepared = await client.rpc('sg_cloud_save', {
        p_action: 'prepare', p_slot: 'cleanup-regression',
        p_request: { operationId: crypto.randomUUID(), expectedRevision: 0, schemaVersion: 1, metadata: {}, sizeBytes: bytes.length, checksum },
      });
      expect(prepared.error).toBeNull();
      paths.push(prepared.data.upload.path);
      if (upload) {
        const uploaded = await client.storage.from('supagame-saves').upload(paths[i]!, bytes, { contentType: 'application/octet-stream' });
        expect(uploaded.error).toBeNull();
      }
    }
    await expect((async () => {
      try { throw new Error('Simulated failure before metadata commit'); }
      finally { await cleanupLocalUsers([users[0]!]); }
    })()).rejects.toThrow('Simulated failure before metadata commit');
    expect(query(`select count(*) from auth.users where id='${users[0]}'`)).toBe('0');
    expect(query(`select count(*) from sg_private.save_objects where user_id='${users[0]}'`)).toBe('0');
    expect(query(`select count(*) from storage.objects where bucket_id='supagame-saves' and name='${paths[0]}'`)).toBe('0');
    // Repeated cleanup is safe and does not sweep another suite's fixtures.
    await cleanupLocalUsers([users[0]!]);
    expect(query(`select count(*) from auth.users where id='${users[1]}'`)).toBe('1');
    expect(query(`select count(*) from sg_private.save_objects where user_id='${users[1]}'`)).toBe('1');
    expect(query(`select count(*) from storage.objects where bucket_id='supagame-saves' and name='${paths[1]}'`)).toBe(upload ? '1' : '0');
  } finally {
    await cleanupLocalUsers(users);
  }
});
