// Fixed local Docker fixture only; never accepts a remote connection string.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const psqlArgs = [
  'exec', '-i', 'supabase_db_supagame-schema-tests',
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres',
];

export function query(sql: string): string {
  return execFileSync('docker', [...psqlArgs, '-c', sql], { encoding: 'utf8', timeout: 15_000 }).trim();
}

export function session(sql: string) {
  const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { stdout: '', stderr: '', exited: false };
  child.stdout.on('data', (chunk: Buffer) => { state.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { state.stderr += chunk.toString(); });
  const finished = new Promise<string>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      state.exited = true;
      if (code === 0) resolve(state.stdout);
      else reject(new Error(`Local psql exited ${code}: ${state.stderr}`));
    });
  });
  // Completion is awaited after lock inspection; do not emit an early unhandled rejection.
  void finished.catch(() => undefined);
  child.stdin.write(sql);
  return { child, state, finished };
}

export async function waitUntil(condition: () => boolean, description: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, description);
    await setTimeout(20);
  }
}
