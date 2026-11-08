import { copyFileSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';

const directory = 'tests/fixtures/local/supabase/functions';
try {
  copyFileSync(`${directory}/.env.example`, `${directory}/.env`, constants.COPYFILE_EXCL);
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
}
try {
  // The CLI prints privileged local keys on startup. Discard that output rather
  // than writing it into terminal logs, fixtures or CI artifacts.
  execFileSync('supabase', ['start', '--workdir', 'tests/fixtures/local',
    '--network-id', 'supagame-schema-tests-local'], { stdio: 'ignore' });
  console.log('Local Supabase API ready at http://127.0.0.1:55431. Run pnpm db:migrate next.');
} catch {
  console.error('Local Supabase startup failed. Check Docker availability and fixture ports 55430–55433.');
  process.exitCode = 1;
}
