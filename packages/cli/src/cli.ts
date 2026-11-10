#!/usr/bin/env node
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
    'Module name: leaderboards or live-leaderboards',
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
local(program.command('upgrade').description('Stage known forward-only module upgrades locally'))
  .action((options: LocalOptions) => upgrade(options));
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
