import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const entrypoint = fileURLToPath(new URL('../../packages/cli/src/cli.ts', import.meta.url));
const commands = ['init', 'add', 'leaderboard', 'deploy', 'doctor', 'upgrade'];

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [entrypoint, ...args], { encoding: 'utf8' });
}

describe('supagame CLI bootstrap', () => {
  it('lists the six provisioning commands in --help', () => {
    const result = runCli('--help');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: supagame');
    for (const command of commands) {
      expect(result.stdout).toMatch(new RegExp(`^  ${command}\\b`, 'm'));
    }
  });

  it('shows help when invoked without arguments', () => {
    const result = runCli();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: supagame');
  });

  it.each(commands.filter(name => !['init', 'add'].includes(name)))('%s fails clearly until its owning task implements it', (command) => {
    const result = runCli(command);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${command}: not yet implemented`);
    expect(result.stdout).toBe('');
  });

  it.each(commands)('%s --help succeeds without running the command', (command) => {
    const result = runCli(command, '--help');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`Usage: supagame ${command}`);
  });

  it('rejects unknown commands', () => {
    const result = runCli('unknown');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command 'unknown'");
  });
});
