import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo, run } from './packages.ts';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
export async function localProject() {
  const root = mkdtempSync(join(tmpdir(), 'supagame-e2e-'));
  const id = `supagame-e2e-${randomBytes(6).toString('hex')}`;
  const ports = new Set<number>();
  while (ports.size < 5) ports.add(await freePort());
  const [api, db, shadow, inspector, browserPort] = [...ports];
  const url = `http://127.0.0.1:${api}`;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'CI', 'DOCKER_HOST', 'DOCKER_CONTEXT']) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const supabase = (args: string[]) => {
    if (args.some((value) => value.startsWith('--remote') || ['deploy', 'reset', '--all', '--linked'].includes(value))) throw new Error('Hosted/destructive commands are forbidden in E2E');
    return run(join(repo, 'node_modules/.bin/supabase'), [...args, '--workdir', root, '--network-id', id], root, env);
  };
  let network = false;
  let starting = false;
  let cleaned = false;
  function remove() {
    if (cleaned) return;
    // Exact test-owned ID/workdir only. Never stop any other project or prune Docker.
    if (starting) supabase(['stop', '--project-id', id, '--no-backup']);
    if (network) run('docker', ['network', 'rm', id]);
    rmSync(root, { recursive: true, force: true });
    cleaned = true;
  }
  try {
    supabase(['init', '--yes']);
    writeFileSync(join(root, 'supabase/config.toml'), `project_id = "${id}"
[api]
enabled = true
port = ${api}
schemas = ["public"]
extra_search_path = ["public", "extensions"]
auto_expose_new_tables = true
[db]
port = ${db}
shadow_port = ${shadow}
major_version = 17
health_timeout = "2m"
[db.seed]
enabled = false
[studio]
enabled = false
[realtime]
enabled = false
[storage]
enabled = false
[local_smtp]
enabled = false
[analytics]
enabled = false
[edge_runtime]
enabled = true
inspector_port = ${inspector}
[auth]
enabled = true
site_url = "${url}"
enable_anonymous_sign_ins = true
[auth.email]
enable_confirmations = false
`);
    mkdirSync(join(root, 'supabase/functions'), { recursive: true });
    writeFileSync(join(root, 'supabase/functions/.env'), `SG_AUTH_ISSUER=${url}/auth/v1\nSG_ALLOWED_ORIGINS=["http://127.0.0.1:${browserPort}"]\n`, { mode: 0o600 });
    return {
      root, id, url, browserPort: browserPort!, supabase, remove,
      start() {
        run('docker', ['network', 'create', '--driver', 'bridge', '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', id]);
        network = true; starting = true;
        supabase(['start']); // Runs all staged migrations and loads the staged function.
        supabase(['migration', 'up']); // No-op verifies the local ledger is current.
      },
    };
  } catch (error) { remove(); throw error; }
}
