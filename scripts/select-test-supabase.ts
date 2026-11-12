// Test infrastructure only: the reproducible development dependency stays pinned.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const releases: Record<string, string> = {
  '3.0.0': 'eeb61edcd59a4735fcb5e58596574f25d03d420efca779f43ddb307e1cc5c754',
  '3.1.0': 'dbe9fd66771337fc198727da86b9d3551302f87a7091cd8781be2a4cd0c8ac4d',
};
const version = process.argv[2] ?? '';
if (!Object.hasOwn(releases, version) || process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Usage: node scripts/select-test-supabase.ts <3.0.0|3.1.0> (Linux x64 test environments only).');
}
const directory = resolve('node_modules/.cache/supagame-supabase', version);
mkdirSync(directory, { recursive: true });
const archive = resolve(directory, 'release.tar.gz');
const response = await fetch(`https://github.com/supabase/cli/releases/download/v${version}/supabase_${version}_linux_amd64.tar.gz`);
if (!response.ok) throw new Error(`Supabase test binary download failed (${response.status}).`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== releases[version]) {
  throw new Error('Supabase test archive checksum mismatch; existing executable preserved.');
}
writeFileSync(archive, bytes);
execFileSync('tar', ['-xzf', archive, '-C', directory, 'supabase']);
const binary = resolve(directory, 'supabase');
const actual = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 }).trim();
if (actual !== version || readFileSync(binary).length === 0) throw new Error('Unexpected Supabase test executable.');
rmSync(resolve('node_modules/.bin/supabase'), { force: true });
symlinkSync(binary, resolve('node_modules/.bin/supabase'));
console.log(`Selected official Supabase CLI ${version}; SHA256 ${releases[version]}.`);
