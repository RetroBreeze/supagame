#!/usr/bin/env node
import { Command } from 'commander';
import { init } from './commands/init.ts';
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
  .action((options: LocalOptions) => init(options));
local(
  program.command('add').description('Stage a game services module').argument(
    '<module>',
    'Module name: leaderboards',
  ),
)
  .action((module: string, options: LocalOptions) => add(module, options));
for (
  const [name, description] of [
    ['leaderboard', 'Configure leaderboard definitions'],
    ['deploy', 'Preview and explicitly confirm deployment'],
    ['doctor', 'Diagnose the installation and configuration'],
    ['upgrade', 'Stage additive module upgrades'],
  ]
) {
  program.command(name!).description(`${description} (not yet implemented)`)
    .action(() => program.error(`${name}: not yet implemented`, { exitCode: 1 }));
}
if (process.argv.length === 2) program.help();
try {
  program.parse();
} catch (error) {
  program.error(
    error instanceof Error
      ? error.message
      : 'Local setup failed; inspect project permissions and retry.',
    { exitCode: 1 },
  );
}
