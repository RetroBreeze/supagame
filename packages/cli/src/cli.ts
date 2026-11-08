#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command()
  .name('supagame')
  .description('Install modular game services into your own Supabase project.');

const commands = [
  ['init', 'Initialize the local game services configuration'],
  ['add', 'Stage a game services module'],
  ['leaderboard', 'Configure leaderboard definitions'],
  ['deploy', 'Preview and explicitly confirm deployment'],
  ['doctor', 'Diagnose the installation and configuration'],
  ['upgrade', 'Stage additive module upgrades'],
] as const;

for (const [name, description] of commands) {
  program.command(name)
    .description(`${description} (not yet implemented)`)
    .action(() => {
      program.error(`${name}: not yet implemented`, { exitCode: 1 });
    });
}

if (process.argv.length === 2) program.help();
program.parse();
