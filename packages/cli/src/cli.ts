#!/usr/bin/env node
import { adminCommand } from './commands/admin.ts';
import { configureAuth } from './commands/auth.ts';
import { cleanupSaves } from './commands/saves-cleanup.ts';
import { configureSaves } from './commands/saves-configure.ts';
import { createAchievement } from './commands/achievement-create.ts';
import { doctor, doctorExitCode } from './commands/doctor.ts';
import type { DoctorOptions } from './commands/doctor.ts';
import { upgrade } from './commands/upgrade.ts';
import { Command } from 'commander';
import { addOrigins } from './commands/config-origins.ts';
import { init } from './commands/init.ts';
import { deploy } from './commands/deploy.ts';
import type { DeployOptions } from './commands/deploy.ts';
import { createLeaderboard } from './commands/leaderboard-create.ts';
import type { BoardOptions } from './lib/migration-generator.ts';
import { add } from './commands/add.ts';
import type { LocalOptions } from './lib/project.ts';

const program = new Command().name('supagame').description(
  'Install modular game services into your own Supabase project.',
);
function local(command: Command): Command {
  return command.option(
    '--workdir <directory>',
    'Explicit project root (default: current directory; no parent search)',
  )
    .option(
      '--dry-run',
      'Show local creates, updates, unchanged files and conflicts without writing',
    );
}
local(
  program.command('init').description(
    'Initialize the local game services manifest',
  ),
)
  .option(
    '--project-ref <ref>',
    'Record this Supabase project ref; must agree with local link metadata',
  )
  .option('--origin <origin>', 'Allow a browser origin (repeatable)', (value: string, previous: string[]) => [...(previous ?? []), value], undefined as string[] | undefined)
  .action((options) => init(options));
local(program.command('config').description('Manage installation configuration').command('origins').description('Manage allowed browser origins').command('add').argument('<origins...>'))
  .action((origins: string[], options: LocalOptions) => addOrigins(origins, options));
local(
  program.command('add').description('Stage a game services module').argument(
    '<module>',
    'Module name: leaderboards, live-leaderboards, achievements, cloud-saves or admin',
  ),
)
  .action((module: string, options: LocalOptions) => add(module, options));
local(
  program.command('leaderboard').description(
    'Configure leaderboard definitions',
  ).command('create').argument('<id>'),
)
  .requiredOption('--type <type>', 'time or points')
  .requiredOption('--order <order>', 'asc or desc')
  .option('--keep-best', 'Retain only personal best scores (required)')
  .option('--min <integer>', 'Minimum accepted score')
  .option('--max <integer>', 'Maximum accepted score')
  .action((id: string, options: LocalOptions & BoardOptions) => createLeaderboard(id, options));
local(program.command('achievement').description('Configure immutable achievement definitions').command('create').argument('<id>'))
.requiredOption('--title <text>', 'Display title').requiredOption('--description <text>', 'Description')
.requiredOption('--board <id>', 'Existing descending leaderboard').requiredOption('--threshold <integer>', 'Single accepted score threshold')
.option('--icon <id>', 'Game-defined icon identifier').option('--category <text>', 'Category').option('--metadata <json>', 'Optional JSON object')
.action(createAchievement);
local(
  program.command('deploy').description(
    'Preview all pending migrations and explicitly authorize hosted deployment',
  ),
)
  .option(
    '--project-ref <ref>',
    'Exact target; must match manifest and linked project',
  )
  .option(
    '--allow-remote',
    'Explicitly authorize hosted changes without a prompt (CI opt-in)',
  )
  .option('--replace-origins', 'Explicitly replace unknown/non-additive SG_ALLOWED_ORIGINS with ALL manifest origins; deployment authorization still required')
  .action((options: DeployOptions) => deploy(options));
program.command('doctor').description('Read-only installation, schema and security diagnostics')
  .option('--workdir <directory>', 'Explicit project root')
  .option('--local', 'Inspect the running local database')
  .option('--remote', 'Inspect the explicitly selected hosted project read-only')
  .option('--project-ref <ref>', 'Exact matching hosted project reference')
  .action(async (options: DoctorOptions) => {
    const findings = await doctor(options);
    process.exitCode = doctorExitCode(findings, Boolean(options.local || options.remote));
  });
const authCommand = program.command('auth').description('Configure and diagnose provider authentication (separate from CORS)');
for (const name of ['configure', 'doctor']) {
  local(authCommand.command(name)).option('--local', 'Local Auth configuration').option('--remote', 'Explicit hosted Auth configuration')
    .option('--project-ref <ref>', 'Exact matching hosted project reference')
    .option('--redirect <url>', 'Exact application callback URL, repeatable', (v: string, prior: string[]) => [...prior, v], [])
    .option('--site-url <url>', 'Explicit Auth site URL').option('--enable-google', 'Configure Google using GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables')
    .option('--allow-remote', 'Authorize the previewed narrow Auth patch without a prompt')
    .action(options => configureAuth({...options, doctor: name === 'doctor'}));
}
const savesCommand = program.command('saves').description('Configure and maintain Cloud Saves');
local(savesCommand.command('cleanup')).option('--local', 'Clean only the local stack').option('--remote', 'Clean an explicitly selected hosted project').option('--project-ref <ref>', 'Exact hosted destination').option('--allow-remote', 'Authorize the displayed hosted cleanup without a prompt').action(cleanupSaves);
local(savesCommand.command('configure'))
  .option('--max-slots <integer>', 'Active slots per player')
  .option('--max-json-bytes <integer>', 'Maximum JSON bytes per slot (up to 1 MiB)')
  .option('--max-binary-bytes <integer>', 'Maximum binary bytes per slot')
  .option('--max-total-bytes <integer>', 'Total bytes per player, including incomplete uploads')
  .action(configureSaves);
local(program.command('upgrade').description('Stage known forward-only module upgrades locally'))
  .action((options: LocalOptions) => upgrade(options));
const admin = program.command('admin').description('Trusted operator administration; requires optional Admin module');
for (const [kind, verbs] of Object.entries({leaderboard:['list','inspect','reset','disable','enable'],score:['inspect','hide','restore'],player:['inspect','restrict','reinstate'],audit:['list'],doctor:['doctor']})) {
 const group = kind === 'doctor' ? admin : admin.command(kind);
 for (const verb of verbs) {
  const cmd = local(group.command(verb)).option('--local','Use local database').option('--remote','Use hosted database')
   .option('--project-ref <ref>','Exact matching hosted project').option('--reason <text>','Required modification reason')
   .option('--generation <integer>','Inspect historical generation submissions').option('--operation-id <uuid>','Original operation UUID for retry').option('--expected-revision <integer>','Original revision for retry')
   .option('--allow-remote','Explicit authorization for hosted modification').option('--yes','Explicit authorization for local modification').option('--json','Machine-readable inspection output');
  if(!['list','doctor'].includes(verb)) cmd.argument('<target>').action((target,opts)=>adminCommand(kind as 'leaderboard'|'score'|'player',verb,target,opts));
  else cmd.action(opts=>adminCommand(kind as 'leaderboard'|'audit'|'doctor',verb,undefined,opts));
 }
}
if (process.argv.length === 2) program.help();
try {
  await program.parseAsync();
} catch (error) {
  program.error(
    error instanceof Error
      ? error.message
      : 'Local setup failed; inspect project permissions and retry.',
    { exitCode: 1 },
  );
}
